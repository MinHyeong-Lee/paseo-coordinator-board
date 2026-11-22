import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BoardFacts } from "../server/board-facts";
import { ConversationReader } from "../server/conversation";
import { discoverSessions } from "../server/discovery";
import { NoteStore } from "../server/notes";
import { PreferenceStore } from "../server/preferences";
import { managedSessions } from "../server/session-links";
import { decorateDecision } from "../server/decisions";
import { projectCards } from "../client/model";

const dirs: string[] = [];
afterEach(()=>{for (const dir of dirs.splice(0)) rmSync(dir,{recursive:true,force:true});});
const question = "이 작업은 어느 프로젝트 소속인가요?";
const page = entries => ({entries,pageInfo:{hasMore:false,nextCursor:null}});
function fixture(initial=question) {
  const dir=mkdtempSync(join(tmpdir(),"board-fact-test-")); dirs.push(dir);
  const store=new PreferenceStore(join(dir,"scope.json")), notes=new NoteStore(join(dir,"notes.json")), reader=new ConversationReader();
  store.change(s => {s.projects=["managed"];s.coordinator="coord";s.sessionLinks.worker={sessionId:"worker",sourceProjectId:"source",targetProjectId:"managed",targetProjectTitle:"Managed",sourceProjectTitle:"Source",workspaceTitle:"Original",title:"Worker"};});
  let now=Date.now();
  const facts=new BoardFacts(store,notes,reader,()=>now);
  const states={coord:{id:"coord",updatedAt:"1",status:"idle",pendingPermissions:[]},worker:{id:"worker",updatedAt:"1",status:"idle",pendingPermissions:[]}};
  const turns={worker:[{type:"assistant_message",text:initial}],coord:[{type:"user_message",text:"new digest",messageId:"actual-digest"}]};
  const events=[], behavior={throws:false,afterRefresh:()=>{}};
  const sdk={workspaces:{list:async()=>page([])},agents:{
    list:async()=>page(Object.values(states).map(agent=>({agent:{...agent},project:{projectKey:agent.id==="coord"?"managed":"source"}}))),
    ref:id=>({
      timeline:{refetch:async()=>({epoch:"epoch",entries:turns[id].map((item,seqEnd)=>({item:{...item},seqEnd}))})},
      refresh:async()=>{behavior.afterRefresh();return {agent:states[id]};},
      send:async(text,opts)=>{events.push({id,text,...opts});if(behavior.throws)throw Error("unconfirmed");},
    }),
  }};
  const snapshot=async()=>{
    const scope=store.read(),rows=managedSessions(await discoverSessions(sdk),scope);
    const e=await reader.decorate(sdk,rows,scope);
    const n=notes.visible(new Set(rows.map(r=>r.id)));
    facts.decorate(rows,e,n);
    for(const row of rows)decorateDecision(row,n[row.id],store.read());
    const cards=projectCards({sessions:rows,notes:n,projects:[],coordinator:"coord"});
    return {w:rows.find(r=>r.id==="worker"),cards};
  };
  const seed=async(key="digest-1")=>{
    const token=await facts.prepareCycle(sdk,"coord",key);
    if(token)facts.bindMessage("coord",token,"actual-digest");
    return token;
  };
  const reply=(cycleId,evidenceId,caller="coord",factService=facts)=>factService.tool.execute({cycleId,evidenceId,sessionId:"worker"},{paseo:sdk,agent:{id:caller}});
  return {store,notes,reader,states,turns,events,behavior,facts,sdk,snapshot,seed,reply,tick:ms=>{now+=ms}};
}
test("cached snapshots resolve exact questions and keep durable evidence without prompting or changing workspace",async()=>{
  for(const [q,kind] of [[question,"project"],["이 세션은 어느 프로젝트에 속해 있나요?","project"],["이 세션이 관리 프로젝트에 연결되어 있나요?","managed"],["What is the current status of this session?","status"],["상태 공유입니다. 요청할 결정은 없습니다.","report"]]){
    const f=fixture(q);
    const {w,cards}=await f.snapshot();
    expect(w.boardFact).toMatchObject({kind,current:true,sourceProjectId:"source",projectId:"managed",recipientId:"worker",delivery:"recorded"});
    expect(w.boardFact.evidenceId).toBe(w.evidenceId);expect(cards.human).toHaveLength(0);
    expect((await f.snapshot()).w.boardFact).toEqual(w.boardFact);
    expect(Object.keys(f.store.read().factHistory)).toHaveLength(1);expect(f.events).toHaveLength(0);
    if(kind==="report")expect(await f.seed()).toBeNull();
  }
});
test("mixed questions, quotations, truncated messages, authority and preferences never generate machine replies",async()=>{
  for(const q of [question+" 병합해도 될까요?","이 세션의 현재 상태는 무엇인가요?\n폴더 삭제를 승인해 주세요.","고객에게 공개할까요?","예산을 추가할까요?","> "+question,"계획을 승인해 주세요.","성공했습니다. 복구를 진행할까요?", "Use model X or Y?", "x".repeat(2020)+" ".repeat(2100)+question]){
    const f=fixture(q);expect((await f.snapshot()).w.boardFact).toBeUndefined();expect(await f.seed()).toBeNull();expect(f.events).toHaveLength(0);
  }
  const f=fixture();f.states.worker.pendingPermissions=[{id:"permission"}];
  expect((await f.snapshot()).w.decision.source).toBe("permission");expect(await f.seed()).toBeNull();
  f.states.worker.pendingPermissions=[];
  f.notes.update({sessionId:"worker",kind:"question",text:"Choose the product name",expectedRevision:0});
  expect((await f.snapshot()).w.boardFact).toBeUndefined();expect(await f.seed()).toBeNull();
});
test("only one sourced fact reply is sent for the current digest, session and evidence; rereads never resend",async()=>{
  const f=fixture();const {w}=await f.snapshot();const token=await f.seed();
  expect(await f.seed()).toBe(token);
  await expect(f.reply(token,w.evidenceId,"worker")).rejects.toThrow();
  await expect(f.reply(token,"wrong-evidence")).rejects.toThrow();
  await Promise.all([f.reply(token,w.evidenceId),f.reply(token,w.evidenceId)]);
  expect(f.events).toHaveLength(1);expect(f.events[0]).toMatchObject({id:"worker",sourceAgentId:"coord",activeTurnBehavior:"steer"});
  expect(JSON.parse(f.events[0].text)).toMatchObject({type:"coordinator-board.fact",authority:"information-only",evidenceId:w.evidenceId});
  expect((await f.snapshot()).w.boardFact).toMatchObject({senderId:"coord",messageId:f.events[0].messageId,delivery:"sent"});
  const restarted=new BoardFacts(f.store,f.notes,new ConversationReader());
  await f.reply(token,w.evidenceId,"coord",restarted);expect(f.events).toHaveLength(1);
  f.turns.worker.push({type:"assistant_message",text:"다음 PR 병합을 승인해 주세요."});f.states.worker.updatedAt="2";
  const next=await f.snapshot();expect(next.w.boardFact.current).toBe(false);expect(next.cards.human.map(c=>c.session.id)).toEqual(["worker"]);
});
test("expiry, read-only or newer requests, scope changes, later human responses and opt-out cancel sends",async()=>{
  for(const change of ["expire","recommend","unlinked","permission","later","disable","rotation","during"]){
    const f=fixture();const {w}=await f.snapshot();const token=await f.seed();
    if(change==="expire")f.tick(11*60000);
    if(change==="recommend")f.turns.coord.push({type:"user_message",text:"recommend only",messageId:"new-read-only"});
    if(change==="unlinked")f.store.change(s=>{delete s.sessionLinks.worker});
    if(change==="permission") f.states.worker.pendingPermissions=[{id:"p"}];
    if(change==="later")f.turns.worker.push({type:"user_message",text:"I will decide",messageId:"later"});
    if(change==="disable")f.store.change(s=>{s.autoReplyToBoardFacts=false});
    if(change==="rotation")f.store.change(s=>{s.coordinator="worker"});
    if(change==="during")f.behavior.afterRefresh=()=>f.store.change(s=>{s.autoReplyToBoardFacts=false});
    await expect(f.reply(token,w.evidenceId)).rejects.toThrow();expect(f.events).toHaveLength(0);
    if(change==="expire")expect(await f.seed()).toBeNull();
  }
});
test("missing provenance/unknown receipt has no unsigned fallback, and a new digest does not duplicate it",async()=>{
  const f=fixture();const {w}=await f.snapshot();const token=await f.seed();f.behavior.throws=true;
  await expect(f.reply(token,w.evidenceId)).rejects.toThrow(/unsigned/);
  expect((await f.snapshot()).w.boardFact.delivery).toBe("unconfirmed");
  f.behavior.throws=false;
  await expect(f.reply(token,w.evidenceId)).rejects.toThrow(/unconfirmed/);
  const next=await f.seed("next");
  if(next)await expect(f.reply(next,w.evidenceId)).rejects.toThrow(/unconfirmed/);
  expect(f.events).toHaveLength(1);expect(f.events[0].sourceAgentId).toBe("coord");
});
test("a later agent or scheduled input prevents attributing a new turn to the human digest",async()=>{
  for(const who of ["coord","worker"]) {
    const f=fixture();
    const {w}=await f.snapshot(),token=await f.seed();
    f.turns[who].push({type:"tool_call",name:"agent_message",callId:"paseo-agent-message:other",status:"completed",
      agentMessage:{event:"message",sender:{id:"other"},text:"a separate request"}});
    await expect(f.reply(token,w.evidenceId)).rejects.toThrow();
    expect(f.events).toHaveLength(0);
  }
});

test("a lost receipt is reconciled only from Paseo's projected receiving envelope with matching ID, sender and body",async()=>{
  const f=fixture();const {w}=await f.snapshot(),token=await f.seed();
  f.behavior.throws=true;
  await expect(f.reply(token,w.evidenceId)).rejects.toThrow();
  const sent=f.events[0];
  const receipt={type:"tool_call",name:"agent_message",callId:"paseo-agent-message:"+sent.messageId,status:"completed",
    agentMessage:{event:"message",sender:{id:"coord"},text:sent.text}};
  for(const invalid of [{...receipt,callId:"paseo-agent-message:different"},
      {...receipt,agentMessage:{...receipt.agentMessage,sender:{id:"other"}}},
      {...receipt,agentMessage:{...receipt.agentMessage,text:"edited answer"}},
      {type:"user_message",messageId:sent.messageId,text:sent.text}]) {
    f.turns.worker.push(invalid);f.states.worker.updatedAt+="x";
    expect((await f.snapshot()).w.boardFact.delivery).toBe("unconfirmed");
  }
  f.turns.worker.push(receipt);f.states.worker.updatedAt+="x";
  expect((await f.snapshot()).w.boardFact).toMatchObject({current:false,delivery:"sent"});
  expect(f.events).toHaveLength(1);
});
