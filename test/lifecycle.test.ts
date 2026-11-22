import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { attachCoordinatorTools } from "../server/coordinator";
import { ConversationReader } from "../server/conversation";
import { CoordinatorLifecycle } from "../server/lifecycle";
import { isManagedCoordinator, PreferenceStore, setCoordinator } from "../server/preferences";

const paths: string[] = [];
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); });
const start = { expectedCoordinator: null, replace: false, config: { provider: "codex/fixture-model", thinkingOptionId: "high" } };
const decision = { evidenceId: "fixture", kind: "question", text: "언제 공개할까요?", projectId: "team" };

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "coordinator-mode-"));
  paths.push(dir);
  const path = join(dir, "scope.json"), directory = join(dir, "operate");
  writeFileSync(path, JSON.stringify({ projects: ["team"], coordinator: null, judgments: { worker: decision } }));
  const prefs = new PreferenceStore(path);
  const lifecycle = new CoordinatorLifecycle(prefs, directory);
  const pages = (entries) => ({ entries, pageInfo: { hasMore: false, nextCursor: null } });
  const agents = new Map(), creations = [];
  const effects = { beforeCreate: async (_id) => {}, afterCreate: async (_id) => {} };
  const ws = {
    id: "operating-workspace", current: () => ({ title: null }), setTitle: async () => {},
    agents: { create: async input => {
      creations.push(input);
      await effects.beforeCreate(input.agentId);
      agents.set(input.agentId, { id: input.agentId, workspaceId: ws.id, metadata: input.metadata, pendingPermissions: [], status: "idle" });
      await effects.afterCreate(input.agentId);
    } },
  };
  const sdk = {
    workspaces: { open: async path => { expect(path).toBe(directory); return ws; }, list: () => pages([]) },
    agents: {
      list: () => pages([...agents.values()].map(agent => ({ agent, project: { projectKey: agent.workspaceId === ws.id ? "operate" : "team" } }))),
      ref: id => ({ refresh: async () => agents.has(id) ? { agent: agents.get(id) } : null }),
    },
  };
  return { path, directory, prefs, lifecycle, sdk, effects, agents, creations };
}

test("신규 설치 두 창이 동시에 시작해도 운영 세션 한 개와 기존 발췌 판단을 유지한다", async () => {
  const f = setup();
  const [first, second] = await Promise.all([f.lifecycle.ensure(f.sdk, start), f.lifecycle.ensure(f.sdk, start)]);
  expect(first.sessionId).toBe(second.sessionId);
  expect(second.reused).toBe(true);
  expect(f.creations).toHaveLength(1);
  expect(f.creations[0]).toMatchObject({ agentId: first.sessionId, idempotencyKey: first.sessionId, config: { ...start.config, systemPrompt: expect.stringContaining("read_board_conversation") } });
  expect(f.creations[0].prompt).toBeUndefined();
  expect(f.creations[0].config.toolPolicy).toBeUndefined();
  expect(f.prefs.read().judgments.worker).toEqual(decision);
  expect(f.prefs.read().routing).toEqual({});
  expect(f.prefs.read().routingRevision).toBe(0);
  f.prefs.change(s => setCoordinator(s, null));
  expect((await f.lifecycle.ensure(f.sdk, start)).sessionId).toBe(first.sessionId);
  expect(f.creations).toHaveLength(1);
});

test("교체 승인 전에는 새 세션이 판단할 수 없고, 성공 뒤에는 원래 코디네이터의 도구 호출을 거절한다", async () => {
  const f = setup();
  f.agents.set("original", { id: "original", workspaceId: "repo", status: "idle", pendingPermissions: [] });
  f.prefs.change(s => setCoordinator(s, "original"));
  let hook;
  attachCoordinatorTools({ addHook: (_, h) => { hook = h; return () => {}; } }, f.prefs, new ConversationReader());
  const open = async id => (await hook({ request: { purpose: "interactive", agentId: id, tools: [] } })).tools[0];
  const call = async (tool, id) => JSON.parse((await tool.execute({}, { paseo: f.sdk, agent: { id } })).text);
  const original = await open("original");
  let stagedTool;
  f.effects.beforeCreate = async id => {
    stagedTool = await open(id);
    await expect(call(stagedTool, id)).rejects.toThrow("해제");
    expect(await call(original, "original")).toHaveLength(1);
  };
  const replacement = { ...start, expectedCoordinator: "original", replace: true };
  const next = await f.lifecycle.ensure(f.sdk, replacement);
  expect(isManagedCoordinator(f.prefs.read(), next.sessionId)).toBe(true);
  expect((await call(stagedTool, next.sessionId)).map(r => r.id)).toEqual(["original"]);
  await expect(call(original, "original")).rejects.toThrow("해제");
  expect(f.prefs.read().judgments.worker).toEqual(decision);
  expect((await f.lifecycle.ensure(f.sdk, replacement)).sessionId).toBe(next.sessionId);
  expect(f.creations).toHaveLength(1);
});

test("생성 응답이 끊겨도 이전 코디네이터를 유지하고 재시작 후 같은 ID를 찾아 전환한다", async () => {
  const f = setup();
  f.prefs.change(s => setCoordinator(s, "old"));
  const input = { ...start, expectedCoordinator: "old", replace: true };
  f.effects.afterCreate = async () => { throw Error("연결이 끊겼습니다"); };
  await expect(f.lifecycle.ensure(f.sdk, input)).rejects.toThrow("연결");
  expect(f.prefs.read().coordinator).toBe("old");
  expect(f.prefs.read().judgments.worker).toEqual(decision);
  const restored = new CoordinatorLifecycle(new PreferenceStore(f.path), f.directory);
  expect((await restored.ensure(f.sdk, input)).sessionId).toBe(f.creations[0].agentId);
  expect(f.creations).toHaveLength(1);
});

test("교체 도중 사용자가 다른 담당자를 지목하면 오래된 생성 결과가 그 선택을 덮지 않는다", async () => {
  const f = setup();
  f.effects.afterCreate = async () => { f.prefs.change(s => setCoordinator(s, "chosen-by-person")); };
  await expect(f.lifecycle.ensure(f.sdk, start)).rejects.toThrow("바뀌");
  expect(f.prefs.read().coordinator).toBe("chosen-by-person");
  expect(f.prefs.read().judgments.worker).toEqual(decision);
  await expect(f.lifecycle.ensure(f.sdk, start)).rejects.toThrow("바뀌");
  expect(f.creations).toHaveLength(1);
});

test("현재 호스트에서 선택한 프로젝트가 없거나 교체 중 마지막 프로젝트가 제외되면 코디네이터를 지정하지 않는다", async () => {
  const f = setup();
  f.prefs.change(s => { s.projects = []; });
  await expect(f.lifecycle.ensure(f.sdk, start)).rejects.toThrow("프로젝트");
  expect(f.creations).toHaveLength(0);
  f.prefs.change(s => { s.projects = ["team"]; });
  f.effects.afterCreate = async () => { f.prefs.change(s => { s.projects = []; }); };
  await expect(f.lifecycle.ensure(f.sdk, start)).rejects.toThrow("바뀌");
  expect(f.prefs.read().coordinator).toBe(null);
});

test("운영 공간을 여는 동안 실행기를 제외하면 새 운영 세션을 띄우지 않는다", async () => {
  const f = setup();
  const open = f.sdk.workspaces.open;
  f.sdk.workspaces.open = async path => {
    f.prefs.change(s => { s.excludedProviders = ["codex"]; });
    return open(path);
  };
  await expect(f.lifecycle.ensure(f.sdk, {
    ...start, verifyRoute: scope => {
      if (scope.excludedProviders.includes("codex")) throw new Error("실행기 제외");
    },
  })).rejects.toThrow(/제외/);
  expect(f.creations).toHaveLength(0);
  expect(f.prefs.read().coordinator).toBeNull();
});

test("준비한 새 세션이 다른 권한을 보고하면 기존 운영 세션을 유지한다", async () => {
  const f = setup();
  f.prefs.change(s => { s.coordinator = "old"; });
  f.effects.afterCreate = async id => { f.agents.get(id).currentModeId = "default"; };
  const change = {...start, expectedCoordinator:"old", replace:true, config:{...start.config, modeId:"auto-review"}};
  await expect(f.lifecycle.ensure(f.sdk,change)).rejects.toThrow(/권한 모드/);
  expect(f.prefs.read().coordinator).toBe("old");
  f.agents.get(f.creations[0].agentId).currentModeId = "auto-review";
  expect((await f.lifecycle.ensure(f.sdk,change)).sessionId).toBe(f.creations[0].agentId);
  expect(f.creations).toHaveLength(1);
});
