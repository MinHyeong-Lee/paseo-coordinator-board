import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { clarificationRecipient, sessionClarificationCard, type ClarificationCard } from "../shared/clarifications";
import { ClarificationSender, restoreClarifiedDecision } from "../server/clarifications";
import { permissionVersion } from "../server/discovery";
import { PreferenceStore } from "../server/preferences";
import { verifiedBoardFact } from "../server/board-facts";
import { excerpt } from "../server/conversation";

const scratch: string[] = [];
afterEach(() => { for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true }); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "clarification-routing-"));
  scratch.push(dir);
  const prefs = new PreferenceStore(join(dir, "prefs.json"));
  prefs.change(scope => { scope.projects = ["book"]; scope.coordinator = "coordinator"; });
  const worker = { id: "worker", title: "Writer", projectId: "book", activityAt: "v1", status: "idle", lane: "human",
    decision: { source: "conversation", question: "Release the book?", version: "r1" } };
  const actor = id => ({ id, updatedAt: "v1", status: "idle", pendingPermissions: [] });
  const actors = { worker: actor("worker"), coordinator: actor("coordinator") };
  const view = { sessions: [worker, { ...worker, id: "coordinator" }], notes: {}, coordinator: "coordinator" };
  const calls: { id: string; text: string }[] = [];
  const sdk = { agents: { ref: id => ({
    refresh: async () => ({ agent: actors[id] }),
    send: async (text: string) => { calls.push({ id, text }); },
  }) } };
  const sender = new ClarificationSender(prefs, async () => view);
  const card = sessionClarificationCard(worker)!;
  const request = { card, recipientId: "worker", requestKey: "fixture-first-clarification", question: "What does this change?" };
  return { actors, worker, view, prefs, sdk, sender, request, calls };
}

test("permission explanations reach the coordinator, never the session waiting for consent", async () => {
  const f = fixture();
  const permission = { id: "req-42", title: "Export draft" };
  f.actors.worker.pendingPermissions = [permission];
  f.worker.nativePending = true;
  f.worker.permissionVersion = permissionVersion(f.actors.worker);
  f.worker.decision = { source: "permission", question: "Export draft", version: "permission-card" };
  const card = sessionClarificationCard(f.worker)!;
  expect(sessionClarificationCard({ ...f.worker, permissionVersion: undefined })).toBeNull();
  expect(clarificationRecipient(card, f.view)).toBe("coordinator");
  expect(clarificationRecipient(card, { ...f.view, coordinator: "worker" })).toBeNull();
  const input = { ...f.request, card, recipientId: "coordinator" };
  await f.sender.send(f.sdk, input);
  expect(f.calls.map(c => c.id)).toEqual(["coordinator"]);
  expect(f.calls[0].text).toContain("Export draft");
  expect(f.calls[0].text).toContain('"sourceSessionId":"worker"');
  expect(f.actors.worker.pendingPermissions).toEqual([permission]);
  expect(f.prefs.read().answers).toEqual({});
  expect(f.prefs.read().decisionReceipts).toEqual({});
  f.actors.worker.pendingPermissions = [{ ...permission, id: "different-request" }];
  await expect(f.sender.send(f.sdk, { ...input, requestKey: "fixture-new-clarification" })).rejects.toThrow();
  expect(f.calls).toHaveLength(1);
});

test("PR questions require a current review item and select a single verified workspace or the coordinator", () => {
  const f = fixture();
  const card: ClarificationCard = { kind: "pull", projectId: "book", repo: "a/book", number: 2, updatedAt: "r2" };
  const pr = { ...card, projectIds: ["book"], title: "Fix pagination", lane: "review" };
  const view = { ...f.view, pullRequests: { items: [pr] } };
  const match = { kind: "pr", repo: "a/book", number: 2 };
  expect(clarificationRecipient(card, view)).toBe("coordinator");
  f.worker.workspacePull = match;
  expect(clarificationRecipient(card, view)).toBe("worker");
  view.sessions.push({ ...f.worker, id: "other" });
  expect(clarificationRecipient(card, view)).toBe("coordinator");
  pr.updatedAt = "r3";
  expect(clarificationRecipient(card, view)).toBeNull();
  pr.updatedAt = "r2";
  pr.lane = "progress";
  expect(clarificationRecipient(card, view)).toBeNull();
});

test("a source update, revoked project, or changed recipient during refresh cannot create a receipt", async () => {
  for (const change of [
    f => { f.actors.worker.updatedAt = "r2"; },
    f => { f.prefs.change(p => { p.projects = []; }); },
    f => { f.worker.status = "running"; },
    f => { f.actors.worker.pendingPermissions = [{ id: "new-permission" }]; },
    f => { f.prefs.change(p => { p.answers.worker = { version: "r1" }; }); },
  ]) {
    const f = fixture();
    const sender = new ClarificationSender(f.prefs, async () => { change(f); return f.view; });
    await expect(sender.send(f.sdk, f.request)).rejects.toThrow();
    expect(f.calls).toBeEmpty();
    expect(f.prefs.read().clarifications).toEqual({});
  }
});

test("a factual-sounding explanation does not become a new board action", async () => {
  const f = fixture();
  const { messageId } = await f.sender.send(f.sdk, f.request);
  const turn = text => ({ type: "assistant_message", text });
  const page = { epoch: "book", entries: [ { type: "user_message", text: f.calls[0].text, clientMessageId: messageId },
    turn("what is this session's current status?") ].map((item, seqEnd) => ({ item, seqEnd })) };
  const evidence = excerpt(page);
  const row = { ...f.worker, detail: "" };
  expect(verifiedBoardFact(row, evidence, f.prefs.read())).toBeNull();
  expect(verifiedBoardFact(row, { ...evidence, lastInputIds: undefined }, f.prefs.read())?.kind).toBe("status");
});

test("classifying an explanation as informational cannot clear the original question", async () => {
  const f = fixture();
  const { messageId } = await f.sender.send(f.sdk, f.request);
  f.prefs.change(p => {
    p.judgments.worker = { projectId: "book", evidenceId: "explanation", kind: "idle", text: "Explanation complete." };
  });
  const current = { ...f.worker, lane: "idle", decision: undefined };
  const evidence = { id: "explanation", lastInputIds: [messageId], turns: [] };
  restoreClarifiedDecision(current, undefined, f.prefs.read(), evidence);
  expect(current.decision).toEqual(f.worker.decision);
  expect(current.lane).toBe("human");
  const independent = { ...current, decision: undefined, lane: "idle" };
  restoreClarifiedDecision(independent, undefined, f.prefs.read(), { ...evidence, laterInput: true });
  expect(independent.decision).toBeUndefined();
});
