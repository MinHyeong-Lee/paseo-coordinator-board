import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import contribute from "../index.server";
import { boardScope, boardSnapshot, saveNote } from "../shared/contract";
import { linkSession, listSessionLinks } from "../shared/session-links";
import { sendDecision } from "../shared/decision-actions";

function fixture() {
  const handlers = new Map(), hooks = [];
  const oldHome = process.env.PASEO_HOME;
  process.env.PASEO_HOME = mkdtempSync(join(tmpdir(), "session-links-"));
  try {
    contribute({
      registerSettings() {}, handle(c, handler) { handlers.set(c.name, handler); },
      addHook(key, hook) { hooks.push(hook); return () => {}; },
    });
  } finally {
    if (oldHome === undefined) delete process.env.PASEO_HOME;
    else process.env.PASEO_HOME = oldHome;
  }
  const reads = [], sent = [];
  const projects = ["origin", "public", "other"].map(id => ({
    projectId: id, projectCustomName: id === "other" ? "다른" : "동명 프로젝트", projectRootPath: "/" + id,
  }));
  const actors = { worker: "origin", sibling: "origin", coord: "public", other: "other" };
  const agent = id => ({ id, title: id === "coord" ? "코디네이터" : "동명 작업", workspaceId: "w-" + actors[id], status: "idle", updatedAt: "1", pendingPermissions: [] });
  const page = entries => ({ entries, pageInfo: { hasMore: false, nextCursor: null } });
  const signals = { afterRead: async () => {} };
  const sdk = {
    projects: { list: async () => ({ projects }) },
    workspaces: { ref: id => ({ refresh: async () => ({ id, projectId:id.slice(2), workspaceDirectory:"/workspace" }) }), list: async () => page(projects.map(p => ({
      id: "w-" + p.projectId, projectId: p.projectId, workspaceDirectory: p.projectRootPath, projectDisplayName: p.projectCustomName, name: "space",
    }))) },
    agents: {
      list: async () => page(Object.entries(actors).map(([id, projectKey]) => ({ agent: agent(id), project: { projectKey, projectName:"동명 프로젝트" } }))),
      ref: id => ({
        refresh: async () => actors[id] ? { agent: agent(id) } : null,
        timeline: { refetch: async () => {
          reads.push(id);
          await signals.afterRead();
          return { epoch: "test", entries: [{ seqEnd: 1, item: { type: "assistant_message", text: "어느 자막을 택할까요?" } }] };
        } },
        send: async text => sent.push([id, text]),
      }),
    },
  };
  async function rpc(c, i) { return c.output.parse(await handlers.get(c.name)(c.input.parse(i), { paseo:sdk })); }
  const select = (id, enabled=true) => rpc(boardScope, { kind:"project", projectId:id, enabled });
  const link = (target="public", expected=null, sessionId="worker", sourceProjectId="origin") => rpc(linkSession, { sessionId, sourceProjectId, targetProjectId:target, expectedTargetProjectId:expected });
  const board = () => rpc(boardSnapshot, {});
  async function tools() {
    await rpc(boardScope, { kind:"coordinator", sessionId:"coord" });
    const req={purpose:"interactive",agentId:"coord",metadata:{},tools:[]};
    const actions = (await Promise.all(hooks.map(h=>h({request:req})))).flatMap(v=>v?.tools ?? []);
    return (name, input) => actions.find(t=>t.name===name).execute(input,{paseo:sdk,agent:{id:"coord"}});
  }
  return { actors, reads, sent, signals, rpc, select, link, board, tools };
}

test("선택한 기존 세션 하나만 재분류하며 원래 프로젝트와 워크스페이스, 대화 ID를 그대로 유지한다", async () => {
  const f=fixture();await f.select("public");await f.link();
  const snapshot=await f.board();
  expect(snapshot.projects.find(p=>p.id==="origin").selected).toBe(false);
  expect(snapshot.sessions.map(s=>s.id).sort()).toEqual(["coord","worker"]);
  expect(snapshot.sessions.find(s=>s.id==="worker")).toMatchObject({projectId:"public",sourceProjectId:"origin",workspaceTitle:"space"});
  expect(f.reads.sort()).toEqual(["coord","worker"]);
  await f.select("origin");const both=await f.board();
  expect(both.sessions.filter(s=>s.id==="worker").map(s=>s.projectId)).toEqual(["public"]);
  expect(both.sessions.find(s=>s.id==="sibling").projectId).toBe("origin");
  await f.link(null,"public");
  expect((await f.board()).sessions.find(s=>s.id==="worker")).toMatchObject({id:"worker",projectId:"origin"});
  expect(f.sent).toEqual([]);
});

test("연결 목록은 발췌를 읽지 않고 동명 프로젝트·세션을 ID로 구분하며 사라진 대상도 해제한다", async () => {
  const f=fixture();await f.select("public");
  await expect(f.link("other")).rejects.toThrow("먼저 선택");
  await expect(f.link("public",null,"worker","other")).rejects.toThrow();
  await f.link();
  await expect(f.link(null,null)).rejects.toThrow("바뀌었습니다");
  delete f.actors.worker;
  const result=await f.rpc(listSessionLinks,{});
  expect(result.sessions.find(s=>s.sessionId==="worker")).toMatchObject({available:false,sourceProjectId:"origin",targetProjectId:"public"});
  expect(f.reads).toEqual([]);
  await f.link(null,"public");
  expect((await f.rpc(listSessionLinks,{})).sessions.some(s=>s.sessionId==="worker")).toBe(false);
});

test("발췌·질문분류·결정 전송은 대상 프로젝트를 사용하되 같은 원본 프로젝트의 형제와 원본 작업공간 생성까지 허용하지 않는다", async () => {
  const f=fixture();await f.select("public");await f.link();
  const run=await f.tools();
  expect(JSON.parse((await run("read_board_conversation",{})).text).map(r=>r.id).sort()).toEqual(["coord","worker"]);
  await expect(run("read_board_conversation",{sessionId:"sibling"})).rejects.toThrow();
  const e=JSON.parse((await run("read_board_conversation",{sessionId:"worker"})).text);
  await run("classify_board_conversation",{sessionId:"worker",evidenceId:e.evidenceId,kind:"question",text:"자막을 선택해 주세요."});
  const card=(await f.board()).sessions.find(s=>s.id==="worker");
  await f.rpc(sendDecision,{projectId:"public",sessionId:"worker",recipientId:"worker",version:card.decision.version,text:"두 줄로 해 주세요.",action:"reply",requestKey:"link-response-key"});
  expect(f.sent).toEqual([["worker","두 줄로 해 주세요."]]);
  await expect(run("assign_board_worker",{job:{projectId:"public",workspaceId:"w-origin",title:"테스트",prompt:"검토",grade:"D",expectedRoute:{provider:"codex",model:"any",effort:null},requestKey:"assignment-key-1"}})).rejects.toThrow("선택한 프로젝트에서 작업 가능한 워크스페이스");
});

test("대상 프로젝트 해제·연결 철회가 발췌 중에도 효력을 내고, 이전 근거로 기록·답변할 수 없다", async () => {
  const f=fixture();await f.select("public");await f.link();const run=await f.tools();
  const e=JSON.parse((await run("read_board_conversation",{sessionId:"worker"})).text);
  f.signals.afterRead=async()=>{f.signals.afterRead=async()=>{};await f.link(null,"public");};
  await expect(run("classify_board_conversation",{kind:"question",text:"옛 요청",sessionId:"worker",evidenceId:e.evidenceId})).rejects.toThrow("범위");
  await expect(f.rpc(saveNote,{sessionId:"worker",kind:"question",text:"옛 요청",expectedRevision:0})).rejects.toThrow();
  await f.link();await f.select("public",false);await f.select("public");
  expect((await f.board()).sessions.map(s=>s.id)).toEqual(["coord"]);
  expect((await f.rpc(listSessionLinks,{})).sessions.find(s=>s.sessionId==="worker").targetProjectId).toBeNull();
});
