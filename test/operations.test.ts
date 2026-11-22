import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { PluginHandlerContext, PluginServerContext } from "@getpaseo/plugin/server";
import { askDigest, operationState, requestWork, setupCoordinator, setProviderInclusion, updateRouting } from "../shared/operations";
import { coordinatorPinSettings, pinCurrentCoordinator, setCoordinatorAutoPin } from "../shared/operations";
import type { DispatchInput } from "../shared/dispatch";
import { createOperations } from "../server/operations";
import { PreferenceStore } from "../server/preferences";

const paths: string[] = [];
afterEach(() => { for (const path of paths.splice(0)) rmSync(path, { recursive: true, force: true }); });

const route = { provider: "codex", model: "gpt-6.2-sol", effort: "high" };
const alternate = { provider: "cursor", model: "gemini-4-neon-high", effort: null };
const projectId = "managed-project";
const workspaceId = "managed-workspace";
const coordinator = "coordinator-A";
const job: DispatchInput = {
  projectId, workspaceId, title: "Test", prompt: "Synthetic task", grade: "C",
  expectedRoute: route, requestKey: "synthetic-job-01",
};
type CreateInput = { agentId: string; idempotencyKey: string; clientMessageId: string; parent: string; config: { provider: string; modeId?: string }; prompt: string; metadata: Record<string, unknown> };
type Rpc = { name: string; input: { parse(value: unknown): unknown }; output: { parse(value: unknown): unknown } };
type Callback = (input: unknown, ctx: { paseo: unknown }) => Promise<unknown>;
const page = <T,>(entries: T[]) => ({ entries, pageInfo: { hasMore: false, nextCursor: null } });

// This fixture has no host registry, networking, transcripts, or model executor.
function scenario(facts?: Parameters<typeof createOperations>[2]) {
  const dir = mkdtempSync(join(tmpdir(), "board-coordinator-operations-"));
  paths.push(dir);
  const store = new PreferenceStore(join(dir, "scope.json"));
  store.change(s => { s.projects = [projectId]; s.coordinator = coordinator; });
  const workspaces = [
    { id: workspaceId, projectId, title: "관리 공간", name: "managed", projectDisplayName: "예제 프로젝트", workspaceDirectory: "/synthetic/selected" },
    { id: "other-space", projectId: "other-project", title: "다른 공간", name: "other", projectDisplayName: "예제 프로젝트", workspaceDirectory: "/synthetic/other" },
  ];
  const nativePins = new Map<string, string>();
  const sessions = new Map<string, CreateInput>();
  const sent: { agentId: string; text: string; messageId: string }[] = [];
  const events: string[] = [];
  const activity = { modes: [{id:"auto",label:"Default Permissions"}, {id:"auto-review",label:"Auto-review"}], beforeModelList: () => {}, providers: ["codex", "cursor"] };
  const paseo = {
    projects: { list: async () => ({projects: workspaces.map(w => ({projectId: w.projectId, projectDisplayName: w.projectDisplayName, projectRootPath: w.workspaceDirectory}))}) },
    workspaces: {
      open: async () => ({
        id: workspaceId, current: () => ({ title: "코디네이터 운영" }),
        agents: { create: async (input: CreateInput) => { sessions.set(input.agentId,input); } },
      }),
      list: async () => { events.push("workspaces.list"); return page(workspaces); },
      ref: (id: string) => ({ refresh: async () => {
        const workspace = workspaces.find(w => w.id === id);
        return workspace ? {...workspace, pinnedAt: nativePins.get(id) ?? null} : null;
      }, setPinned: async (pin: boolean) => { expect(pin).toBe(true); events.push("workspace.pin:" + id); nativePins.set(id, "native-pin"); return { pinnedAt: "native-pin" }; },
        agents: { create: async (input: CreateInput) => {
          events.push("workspace.agents.create");
          const receipt = sessions.get(input.agentId);
          if (receipt) expect(input).toEqual(receipt);
          else sessions.set(input.agentId, input);
          return { id: input.agentId, workspaceId: id };
        } } }),
    },
    agents: {
      list: async () => page([{ agent: {id:coordinator, workspaceId, title:"운영 세션", status:"idle", pendingPermissions:[], updatedAt:"2026-11-22T01:00:00Z"}, project:{projectKey:projectId,projectName:"예제 프로젝트"} }]),
      ref: (id: string) => ({ refresh: async () => {
        if (id === coordinator) return {agent: {id, workspaceId, status:"idle", activeTurn:null, pendingPermissions:[]}};
        const existing = sessions.get(id);
        return existing ? {agent: {id, workspaceId, currentModeId: existing.config.modeId, status:"idle", pendingPermissions:[], metadata: existing.metadata}} : null;
      }, send: async (text: string, options: {messageId: string}) => { sent.push({agentId:id, text, messageId:options.messageId}); } }),
    },
    providers: {
      listAvailable: async () => { events.push("providers.list"); return {providers: activity.providers.map(provider => ({provider,available:provider !== "offline"}))}; },
      listModes: async () => ({modes:activity.modes}),
      snapshot: async () => ({entries: [{provider: "custom-agent", label: "My Code Studio"}]}),
      listModels: async (provider: string) => {
        activity.beforeModelList();
        if (provider === "broken") throw new Error("private fixture message");
        if (provider === "empty") return {models:[]};
        if (provider === "custom-agent") return {models:[{id:"custom/v1", label:"My model"}]};
        const model = provider === "codex" ? route : alternate;
        return { models: [{id: model.model, label: "Fixture", thinkingOptions: model.effort ? [{id: model.effort}] : [], isDefault: true}] };
      },
    },
  };
  const ops = createOperations(store, join(dir, "workspace"), facts);
  const handlers = new Map<string, Callback>();
  ops.register({ handle: (contract: Rpc, handler: Callback) => { handlers.set(contract.name,handler); } } as unknown as PluginServerContext);
  async function call(definition: Rpc, input: unknown) {
    const result = await handlers.get(definition.name)!(definition.input.parse(input), { paseo });
    return definition.output.parse(result) as any;
  }
  async function tool(name: string, input: unknown, caller = coordinator) {
    const t = ops.tools.find(t => t.name === name)!;
    const output = await t.execute(t.input.parse(input) as never, { paseo, agent: { id: caller } } as unknown as PluginHandlerContext & {agent: {id: string}});
    return JSON.parse(output.text);
  }
  return { handlers, events, sessions, sent, activity, store, call, tool };
}

test("digest requests follow the board language and older clients default to Korean", async () => {
  const s = scenario();
  await s.call(askDigest, { coordinator, requestKey: "digest-backward-compatible" });
  await s.call(askDigest, { coordinator, requestKey: "digest-english-language", language: "en" });
  expect(s.sent.map(message => message.agentId)).toEqual([coordinator, coordinator]);
  expect(s.sent[0].text).toContain("조회와 분류");
  expect(s.sent[1].text).toContain("in English");
  expect(s.sent[1].text).toContain("read_board_conversation");
  expect(s.sessions.size).toBe(0);
});

test("the board forwards the person's words only to the current coordinator; it does not create a worker", async () => {
  const s = scenario();
  const text = "선택한 프로젝트의 다음 작업을 검토해서 나눠 주세요.";
  const input = {coordinator, text, requestKey:"human-request-01"};
  await s.call(requestWork, input);
  await s.call(requestWork, input);
  expect(s.sent[0]).toMatchObject({agentId:coordinator, text});
  expect(s.sent[1]).toEqual(s.sent[0]);
  expect(s.sessions.size).toBe(0);
  await expect(s.call(requestWork, {...input, coordinator:"different-session"})).rejects.toThrow(/코디네이터/);
  expect(s.sent).toHaveLength(2);
});

test("coordinator previews its managed workspaces and live route; no worker-create RPC is exposed to a card", async () => {
  const s = scenario();
  expect(s.handlers.has("board.assign-worker")).toBe(false);
  expect(s.handlers.has("board.remote-project")).toBe(false);
  const plan = await s.tool("plan_board_assignment", {});
  expect(plan.workspaces.map(w => w.id)).toEqual([workspaceId]);
  expect(plan.routes.find(r => r.grade === "C").route).toEqual(route);
  expect(s.sessions.size).toBe(0);
});

test("a saved C-grade route reaches the actual worker, the local coordinator is parent, and retries are idempotent", async () => {
  const s = scenario();
  const prefs = {grade:"C", candidates:[alternate], expectedRevision:0};
  await s.call(updateRouting, prefs);
  await expect(s.call(updateRouting, prefs)).rejects.toThrow(/배정표/);
  const state = await s.call(operationState, {});
  expect(state.routing.C).toEqual([alternate]);
  expect(state.revision).toBe(1);
  const plan = await s.tool("plan_board_assignment",{});
  const selected = plan.routes.find(r => r.grade === "C").route;
  expect(selected).toEqual(alternate);
  const withHooks = await s.tool("plan_board_assignment",{needsHooks:true});
  expect(withHooks.routes.find(r => r.grade === "C").route).toBeNull();
  await expect(s.tool("assign_board_worker",{job})).rejects.toThrow(/미리보기/);
  const input = {job:{...job, expectedRoute:selected}};
  const receipt = await s.tool("assign_board_worker",input);
  expect(await s.tool("assign_board_worker",input)).toEqual(receipt);
  expect(s.sessions.size).toBe(1);
  expect(s.sessions.get(receipt.sessionId)).toMatchObject({parent: coordinator, config: {provider: "cursor/gemini-4-neon-high"}, prompt: job.prompt});
});

test("the coordinator cannot dispatch to an excluded project, mismatched workspace, or withdrawn scope", async () => {
  const s = scenario();
  await expect(s.tool("assign_board_worker",{job:{...job, projectId:"other-project",workspaceId:"other-space"}})).rejects.toThrow(/프로젝트/);
  await expect(s.tool("assign_board_worker",{job:{...job, workspaceId:"other-space"}})).rejects.toThrow(/워크스페이스/);
  s.activity.beforeModelList = () => s.store.change(state => {state.projects=[];});
  await expect(s.tool("assign_board_worker",{job})).rejects.toThrow(/프로젝트/);
  expect(s.sessions.size).toBe(0);
});

test("coordinator rotation revokes both tools before discovery and again before spawning", async () => {
  const s = scenario();
  for (const [name, input] of [["plan_board_assignment",{}],["assign_board_worker",{job}]] as const) {
    await expect(s.tool(name,input,"old-coordinator")).rejects.toThrow(/코디네이터/);
  }
  expect(s.events).toEqual([]);
  s.activity.beforeModelList = () => s.store.change(state => {state.coordinator = "successor";});
  await expect(s.tool("assign_board_worker",{job})).rejects.toThrow(/코디네이터/);
  expect(s.sessions.size).toBe(0);
});

test("obsolete cross-host tool inputs fail closed instead of accidentally performing a local assignment", async () => {
  const s = scenario();
  await expect(s.tool("plan_board_assignment",{targetServerId:"removed-target"})).rejects.toThrow();
  await expect(s.tool("assign_board_worker",{targetServerId:"removed-target",job})).rejects.toThrow();
  expect(s.events).toEqual([]);
  expect(s.sessions.size).toBe(0);
});


test("catalog discovers new provider IDs, useful names and unavailable, empty and error states without inspecting config", async () => {
  const s = scenario();
  s.activity.providers.push("custom-agent", "empty", "broken", "offline");
  const state = await s.call(operationState, {});
  expect(state.providers.find(p => p.id === "custom-agent")).toEqual({id:"custom-agent",label:"My Code Studio",available:true,included:true,status:"ready",modelCount:1});
  expect(state.providers.find(p => p.id === "empty")).toMatchObject({available:true,status:"empty",modelCount:0});
  expect(state.providers.find(p => p.id === "broken")).toMatchObject({available:true,status:"error",modelCount:null});
  expect(state.providers.find(p => p.id === "offline")).toMatchObject({available:false,status:"unavailable",modelCount:null});
  expect(JSON.stringify(state)).not.toContain("private fixture message");
  const choice = {provider:"custom-agent",model:"custom/v1",effort:null};
  await s.call(updateRouting,{grade:"C",candidates:[choice],expectedRevision:0});
  const plan = await s.tool("plan_board_assignment",{});
  expect(plan.routes.find(r => r.grade === "C").route).toEqual(choice);
  const created = await s.tool("assign_board_worker",{job:{...job,expectedRoute:choice}});
  expect(s.sessions.get(created.sessionId)?.config.provider).toBe("custom-agent/custom/v1");
  await expect(s.call(updateRouting,{grade:"A",candidates:[choice],expectedRevision:1})).rejects.toThrow(/등급/);
});

test("excluding a provider preserves ordered overrides across reloads, and gates preview, workers and new coordinator sessions", async () => {
  const s = scenario();
  await s.call(updateRouting,{grade:"C",candidates:[route,alternate],expectedRevision:0});
  const off = {provider:"codex",included:false,expectedRevision:1};
  await s.call(setProviderInclusion,off);
  await expect(s.call(setProviderInclusion,{...off,included:true})).rejects.toThrow(/바뀌/);
  const state = await s.call(operationState,{});
  expect(state.providers.find(p=>p.id==="codex").included).toBe(false);
  expect(state.catalog.some(m=>m.provider==="codex")).toBe(false);
  expect(state.routing.C).toEqual([route,alternate]);
  expect(s.store.read().excludedProviders).toEqual(["codex"]);
  const plan = await s.tool("plan_board_assignment",{});
  expect(plan.routes.find(r=>r.grade==="C").route).toEqual(alternate);
  await expect(s.tool("assign_board_worker",{job})).rejects.toThrow(/미리보기/);
  await expect(s.call(setupCoordinator,{replace:true,expectedCoordinator:coordinator,expectedRoute:route})).rejects.toThrow(/코디네이터 모델/);
  const current = await s.tool("assign_board_worker",{job:{...job,expectedRoute:alternate}});
  await s.call(setProviderInclusion,{provider:"cursor",included:false,expectedRevision:2});
  expect((await s.tool("plan_board_assignment",{})).routes.find(r=>r.grade==="C").route).toBeNull();
  expect(s.sessions.has(current.sessionId)).toBe(true);
  await s.call(setProviderInclusion,{provider:"codex",included:true,expectedRevision:3});
  expect((await s.tool("plan_board_assignment",{})).routes.find(r=>r.grade==="C").route).toEqual(route);
  expect(s.store.read().routing.C).toEqual([route,alternate]);
  await expect(s.call(setProviderInclusion,{provider:"not-registered",included:false,expectedRevision:4})).rejects.toThrow(/실행기/);
});

test("all providers failing discovery still render settings and preserve existing preferences", async () => {
  const s = scenario();
  s.activity.providers = ["broken"];
  const state = await s.call(operationState,{});
  expect(state.catalog).toEqual([]);
  expect(state.providers[0]).toMatchObject({id:"broken",status:"error",modelCount:null});
  await s.call(setProviderInclusion,{provider:"broken",included:false,expectedRevision:0});
  expect((await s.call(operationState,{})).providers[0].included).toBe(false);
  await expect(s.tool("plan_board_assignment",{})).rejects.toThrow(/확인/);
});

test("rechecking preferences after discovery blocks a new worker if its provider was turned off mid-request", async () => {
  const s = scenario();
  s.activity.beforeModelList = () => s.store.change(v => { v.excludedProviders = ["codex"]; });
  await expect(s.tool("assign_board_worker", {job})).rejects.toThrow(/미리보기/);
  expect(s.sessions.size).toBe(0);
});

test("removing a custom tool from Paseo leaves its explicit route unassigned until the same tool returns", async () => {
  const s = scenario();
  const choice = {provider:"custom-agent",model:"custom/v1",effort:null};
  s.activity.providers.push(choice.provider);
  await s.call(updateRouting,{grade:"D",candidates:[choice],expectedRevision:0});
  s.activity.providers = ["codex","cursor"];
  expect((await s.tool("plan_board_assignment",{})).routes.find(r=>r.grade==="D").route).toBeNull();
  expect(s.store.read().routing.D).toEqual([choice]);
  s.activity.providers.push(choice.provider);
  expect((await s.tool("plan_board_assignment",{})).routes.find(r=>r.grade==="D").route).toEqual(choice);
});

test("새 코디네이터는 지원되는 자동 심사 모드를 미리 보여 주고 달라진 모드는 적용하지 않는다", async () => {
  const s = scenario();
  const state = await s.call(operationState, {});
  expect(state.coordinatorMode).toEqual({id:"auto-review",label:"Auto-review"});
  s.activity.modes = [{id:"auto",label:"Default Permissions"}, {id:"full-access",label:"Full Access"}];
  expect((await s.call(operationState, {})).coordinatorMode?.id).toBe("auto");
  await expect(s.call(setupCoordinator, {replace:true,expectedCoordinator:coordinator,expectedRoute:route,expectedModeId:"auto-review"})).rejects.toThrow(/권한 모드/);
  s.activity.modes = [{id:"full-access",label:"Full Access"}];
  expect((await s.call(operationState, {})).coordinatorMode).toBeNull();
  await expect(s.call(setupCoordinator, {replace:true,expectedCoordinator:coordinator,expectedRoute:route})).rejects.toThrow(/권한 모드/);
  expect(s.sessions.size).toBe(0);
});

test("생성과 교체 RPC가 Claude 권한 모드를 명시하고 다이제스트는 기존 세션에 텍스트만 보낸다", async () => {
  const s = scenario();
  s.activity.providers = ["claude"];
  s.activity.modes = [{id:"bypassPermissions",label:"Bypass"}, {id:"default",label:"Always Ask"}, {id:"auto",label:"Auto mode"}];
  s.store.change(p => { p.coordinator = null; });
  const choice = {provider:"claude",model:alternate.model,effort:null};
  const first = await s.call(setupCoordinator,{expectedRoute:choice,expectedCoordinator:null,replace:false,expectedModeId:"auto"});
  expect(s.sessions.get(first.sessionId)?.config.modeId).toBe("auto");
  await s.call(askDigest,{coordinator:first.sessionId,requestKey:"digest-after-auto"});
  expect(s.sent.length).toBe(1);
  expect(s.sent[0].agentId).toBe(first.sessionId);
  s.activity.modes = s.activity.modes.filter(m => m.id !== "auto");
  expect((await s.call(operationState,{})).coordinatorMode?.id).toBe("default");
  const next = await s.call(setupCoordinator,{expectedRoute:choice,expectedCoordinator:first.sessionId,replace:true,expectedModeId:"default"});
  expect(s.sessions.get(next.sessionId)?.config.modeId).toBe("default");
  expect(s.sessions.get(first.sessionId)?.config.modeId).toBe("auto");
});

test("sidebar RPCs can pin a selected existing coordinator while auto-pin is off, without pinning another workspace", async () => {
  const s = scenario();
  expect(await s.call(coordinatorPinSettings, {})).toMatchObject({ enabled:true, workspace:{ id:workspaceId, coordinator, pinned:false } });
  await s.call(setCoordinatorAutoPin, {enabled:false});
  expect(s.store.read().autoPinCoordinatorWorkspace).toBe(false);
  await expect(s.call(pinCurrentCoordinator, {coordinator,workspaceId:"other-space"})).rejects.toThrow();
  expect(s.events).toEqual([]);
  const pin = () => s.call(pinCurrentCoordinator, {coordinator,workspaceId});
  await pin();
  await pin();
  expect(await s.call(coordinatorPinSettings, {})).toMatchObject({ enabled:false, workspace:{ pinned:true } });
  await s.call(setCoordinatorAutoPin, {enabled:true});
  expect(s.events).toEqual(["workspace.pin:" + workspaceId]);
});

test("only a digest click with enabled factual handling binds the exact coordinator message", async () => {
  const grants: string[] = [];
  const bound: string[][] = [];
  const cycle = "a".repeat(64);
  const s = scenario({
    async prepareCycle(_sdk, recipient, key) {
      expect(recipient).toBe(coordinator);
      grants.push(key);
      return key === "enabled-facts-01" ? cycle : null;
    },
    bindMessage(recipient, scope, messageId) { bound.push([recipient, scope, messageId]); },
  });
  await s.call(requestWork, {coordinator, requestKey:"regular-work-01", text:"Summarize progress."});
  await s.call(askDigest, {coordinator, requestKey:"legacy-digest-01"});
  await s.call(askDigest, {coordinator, requestKey:"disabled-facts-01", handleBoardFacts:true});
  await s.call(askDigest, {coordinator, requestKey:"enabled-facts-01", handleBoardFacts:true, language:"en"});
  expect(grants).toEqual(["disabled-facts-01", "enabled-facts-01"]);
  expect(bound).toEqual([[coordinator, cycle, s.sent[3].messageId]]);
  expect(s.sent.slice(0, 3).every(msg => !msg.text.includes("answer_board_fact"))).toBe(true);
  expect(s.sent[3].text).toContain(cycle);
  expect(s.sent[3].text).toContain("answer_board_fact");
});
