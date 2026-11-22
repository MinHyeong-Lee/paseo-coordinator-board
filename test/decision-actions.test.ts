import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendDecision, type DecisionInput } from "../shared/decision-actions";
import { requestRecommendation } from "../shared/recommendation";
import { registerRecommendation } from "../server/recommendation";
import { ConversationReader } from "../server/conversation";
import { decorateDecision, DecisionSender } from "../server/decisions";
import { discoverSessions } from "../server/discovery";
import { NoteStore } from "../server/notes";
import { PreferenceStore } from "../server/preferences";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "decision-card-test-"));
  const prefs = new PreferenceStore(join(root, "prefs.json"));
  prefs.change(s => { s.projects = ["project"]; s.coordinator = "coordinator"; });
  const notes = new NoteStore(join(root, "notes.json"));
  const reader = new ConversationReader();
  const sender = new DecisionSender(prefs, notes, reader);
  const actors = Object.fromEntries(["worker", "coordinator", "other"].map(id => [id, {
    id, title: id, updatedAt: "1", status: "idle", pendingPermissions: [], activeTurn: null,
  }]));
  const timelines = { worker: [{ type: "assistant_message", text: "자막을 한 줄로 할까요?" }], coordinator: [], other: [] };
  const sent = [];
  const state = { beforeRefresh: () => {}, loseReceipt: false };
  const page = entries => ({ entries, pageInfo: { hasMore: false, nextCursor: null } });
  const sdk = {
    workspaces: { list: async () => page([]) },
    agents: {
      list: async () => page(Object.entries(actors).map(([id, agent]) => ({
        agent, project: { projectKey: id === "other" ? "unmanaged" : "project", projectName: "책" },
      }))),
      ref: id => ({
        refresh: async () => { state.beforeRefresh(); return { agent: actors[id] }; },
        timeline: { refetch: async () => ({ epoch: id, entries: timelines[id].map((item, seqEnd) => ({ item, seqEnd })) }) },
        send: async (text, { messageId }) => {
          sent.push({ id, text, messageId });
          timelines[id].push({ type: "user_message", text, clientMessageId: messageId });
          if (state.loseReceipt) throw Error("Lost receipt");
        },
      }),
    },
  };

  async function row() {
    const result = (await discoverSessions(sdk)).find(r => r.id === "worker");
    const scope = prefs.read();
    await reader.decorate(sdk, [result], scope);
    decorateDecision(result, notes.visible(new Set(["worker"])).worker, scope);
    return result;
  }
  const initial = await row();
  const input: DecisionInput = {
    projectId: "project", sessionId: "worker", recipientId: "worker", version: initial.decision.version,
    action: "reply", text: "한 줄로 해 주세요.", requestKey: "send-000000001",
  };
  const send = (changes: Partial<DecisionInput> = {}) => sender.send(sdk, sendDecision.input.parse({ ...input, ...changes }));
  return { prefs, notes, sent, send, row, input, actors, timelines, state, reader, sdk, sender };
}

test("구조화 질문·추천·선택은 해당 근거에만 붙고 자유 입력은 클릭한 문장 그대로 원래 세션으로 간다", async () => {
  const f = await fixture();
  const original = await f.row();
  expect(original.decision.source).toBe("conversation");
  f.prefs.change(scope => { scope.judgments.worker = {
    projectId: "project", evidenceId: original.evidenceId, kind: "question", text: "자막 줄 수",
    content: { question: "몇 줄로 만들까요?", recommendation: "한 줄로", options: [{ label: "두 줄", reply: "두 줄로 나눠 주세요." }] },
  }; });
  const current = await f.row();
  expect(current.decision).toMatchObject({ source: "coordinator", question: "몇 줄로 만들까요?", options: [{ label: "두 줄", reply: "두 줄로 나눠 주세요." }] });
  await expect(f.send()).rejects.toThrow("바뀌었습니다");
  const text = "두 줄로 나눠 주세요.\n마지막 자막은 유지해 주세요.";
  const r = await f.send({ version: current.decision.version, text });
  expect(f.sent).toEqual([{ id: "worker", text, messageId: r.messageId }]);
  expect((await f.row()).decisionAnswered).toBe(true);
});

test("질문과 조율은 답변 처리하지 않으며 지정한 세션 이외에는 보낼 수 없다", async () => {
  const f = await fixture();
  await expect(f.send({ recipientId: "other" })).rejects.toThrow();
  await expect(f.send({ action: "coordinate", recipientId: "other" })).rejects.toThrow();
  await f.send({ action: "coordinate", recipientId: "coordinator", text: "두 작업의 순서를 조율해 주세요." });
  expect((await f.row()).decision?.source).toBe("conversation");
  expect(f.sent[0].id).toBe("coordinator");
  await f.send({ action: "question", text: "두 줄로 나누면 어디에서 끊나요?", requestKey: "send-000000002" });
  expect(f.sent[1].id).toBe("worker");
  expect(f.prefs.read().answers).toEqual({});
});

test("권한 요청, 관리 범위 철회, 수신자 교체, 변경된 발췌를 전송 직전 거절한다", async () => {
  for (const scenario of ["native", "recipient-native", "stale", "removed", "rotated", "activity"]) {
    const f = await fixture();
    const changes = ["recipient-native", "rotated"].includes(scenario) ? { action: "coordinate", recipientId: "coordinator" } as const : {};
    if (scenario === "native") {
      f.actors.worker.pendingPermissions.push({ id: "perm" });
      expect((await f.row()).decision?.source).toBe("permission");
    }
    if (scenario === "recipient-native") f.state.beforeRefresh = () => { f.actors.coordinator.pendingPermissions.push({ id: "perm" }); };
    if (scenario === "removed") f.state.beforeRefresh = () => f.prefs.change(s => { s.projects = []; });
    if (scenario === "rotated") f.state.beforeRefresh = () => f.prefs.change(s => { s.coordinator = "other"; });
    if (scenario === "activity") f.state.beforeRefresh = () => { f.actors.worker.updatedAt = "2"; };
    if (scenario === "stale") f.timelines.worker.push({ type: "assistant_message", text: "새 기획 제목을 정해 주세요." });
    await expect(f.send(changes)).rejects.toThrow();
    expect(f.sent).toBeEmpty();
  }
});

test("수신 확인이 끊겨도 동일 요청을 재전송하지 않고 타임라인의 같은 메시지 ID로 복구한다", async () => {
  const f = await fixture();
  f.state.loseReceipt = true;
  const text = "한 줄로 해 주세요.";
  await expect(f.send()).rejects.toThrow("전송 결과");
  await expect(f.send({ text: "바뀐 답" })).rejects.toThrow();
  await expect(f.send({ text: "다른 부탁", requestKey: "other-000000000" })).rejects.toThrow();
  const restarted = new DecisionSender(f.prefs, f.notes, new ConversationReader());
  const result = await restarted.send(f.sdk, { ...f.input, requestKey: "after-restart-0001" });
  expect(result.messageId).toBe(f.sent[0].messageId);
  await expect(restarted.send(f.sdk, { ...f.input, text: "different", requestKey: "after-restart-0001" })).rejects.toThrow("같은 전송 키");
  const replay = await restarted.send(f.sdk, { ...f.input, text });
  expect(replay).toEqual(result);
  expect(f.sent).toHaveLength(1);
});

test("동시 클릭을 한 번만 전달하고 이전 형식의 세션 보고 답장은 후속 결과 확인으로 남긴다", async () => {
  const f = await fixture();
  f.timelines.worker.length = 0;
  f.actors.worker.updatedAt = "2";
  f.notes.update({ sessionId: "worker", kind: "question", text: "제목을 정해 주세요.", expectedRevision: 0 }, "agent");
  const note = await f.row();
  expect(note.decision).toMatchObject({ source: "agent-note", question: "제목을 정해 주세요." });
  const pair = await Promise.all([f.send({ version: note.decision.version }), f.send({ version: note.decision.version })]);
  expect(pair[0]).toEqual(pair[1]);
  expect(f.sent).toHaveLength(1);
  expect((await f.row()).decisionAnswered).toBe(true);
  f.notes.update({ sessionId: "worker", kind: "question", text: "다음 제목은요?", expectedRevision: 1 }, "agent");
  expect((await f.row()).decision?.question).toBe("다음 제목은요?");
});

test("발송 결과가 불명확하고 수신 타임라인에 해당 ID가 없으면 확인 없이 재전송하지 않는다", async () => {
  const f = await fixture();
  f.state.loseReceipt = true;
  await expect(f.send()).rejects.toThrow("전송 결과");
  // A matching sentence from another sender is not a receipt for this board message.
  const last = f.timelines.worker.at(-1);
  last.clientMessageId = "different-id";
  await expect(f.send()).rejects.toThrow("이전 전송 결과");
  expect(f.sent).toHaveLength(1);
  expect(f.prefs.read().answers).toEqual({});
});

test("a recommendation refresh targets just one card and leaves its answer open", async () => {
  const f = await fixture();
  let handler;
  registerRecommendation({handle(contract, fn) { expect(contract.name).toBe(requestRecommendation.name); handler = fn; }}, f.sender);
  const input = requestRecommendation.input.parse({
    sessionId:"worker", projectId:"project", version:f.input.version,
    requestKey:"recommendation-click-01", coordinator:"coordinator", language:"en",
  });
  const invoke = (args = input) => handler(args, {paseo:f.sdk});
  const results = await Promise.all([invoke(), invoke()]);
  expect(results[1]).toEqual(results[0]);
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0].id).toBe("coordinator");
  expect(f.sent[0].text).toContain('"sessionId":"worker"');
  expect(f.sent[0].text).toContain("content.needsInput");
  expect(f.sent[0].text).not.toContain("answer_board_fact");
  expect(f.prefs.read().answers).toEqual({});
  f.actors.worker.pendingPermissions.push({id:"native"});
  expect(await invoke({...input, requestKey:"repeat-recommendation-02"})).toEqual(results[0]);
  await expect(invoke({...input, language:"ko", requestKey:"different-recommendation-03"})).rejects.toThrow();
  expect(f.sent).toHaveLength(1);
});
