import {afterEach,expect,test} from "bun:test";
import {mkdirSync,mkdtempSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import contribute from "../index.server";
import {boardScope,boardSnapshot} from "../shared/contract";
import {sendDecision} from "../shared/decision-actions";
import {askClarification,clarificationKey, type ClarificationCard} from "../shared/clarifications";

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0)) rmSync(root,{recursive:true,force:true});});

async function fixture() {
  const root=mkdtempSync(join(tmpdir(),"board-qa-integration-"));roots.push(root);
  const data=join(root,"plugin-data","coordinator-board");mkdirSync(data,{recursive:true});
  const workers=["editor","writer"];
  const items=workers.map(sessionId=>({source:"studio-ledger",projectId:"studio",projectTitle:"Studio",id:"timing-"+sessionId,
    title:"Timing · "+sessionId,where:"manager",sessionId,questions:[{id:"Q3",text:"How much padding?"}]}));
  writeFileSync(join(data,"tracked-decisions.json"),JSON.stringify({version:1,items}));
  const timelines=new Map<string,any[]>([...workers,"coordinator"].map(id=>[id,[]]));
  const stamp=new Map([...timelines.keys()].map(id=>[id,1]));
  const sent:{id:string;text:string;messageId:string}[]=[];
  let loseAck=false;
  const append=(id:string,item:unknown)=>{timelines.get(id)!.push(item);stamp.set(id,stamp.get(id)!+1);};
  const actor=(id:string)=>({id,title:"Studio "+id,status:"idle",updatedAt:String(stamp.get(id)),workspaceId:"space",pendingPermissions:[]});
  const page=entries=>({entries,pageInfo:{hasMore:false,nextCursor:null}});
  const sdk={
    projects:{list:async()=>({projects:[{projectId:"studio",projectDisplayName:"Studio",projectRootPath:""}]})},
    workspaces:{list:async()=>page([{id:"space",projectId:"studio",workspaceDirectory:"",projectDisplayName:"Studio",name:"space"}])},
    agents:{list:async()=>page([...timelines.keys()].map(id=>({agent:actor(id),project:{projectKey:"studio",projectName:"Studio"}}))),
      ref:(id:string)=>({refresh:async()=>timelines.has(id)?{agent:actor(id)}:null,
        timeline:{refetch:async()=>({epoch:"studio-"+id,entries:timelines.get(id)!.map((item,seqEnd)=>({seqEnd,item}))})},
        send:async(text:string,{messageId}:{messageId:string})=>{
          sent.push({id,text,messageId});append(id,{type:"user_message",text,clientMessageId:messageId});
          if(loseAck) throw Error("synthetic receipt timeout");
        }})},
  };
  function load() {
    const handlers=new Map();
    const old=process.env.PASEO_HOME;
    process.env.PASEO_HOME=root;
    try{contribute({handle:(def,fn)=>handlers.set(def.name,fn),registerSettings(){},addHook:()=>()=>{}} as never);}
    finally{if(old===undefined)delete process.env.PASEO_HOME;else process.env.PASEO_HOME=old;}
    return async (def,input)=>def.output.parse(await handlers.get(def.name)(def.input.parse(input),{paseo:sdk}));
  }
  let rpc=load();
  await rpc(boardScope,{kind:"project",projectId:"studio",enabled:true});
  await rpc(boardScope,{kind:"coordinator",sessionId:"coordinator"});
  const snapshot=()=>rpc(boardSnapshot,{fresh:true});
  return {snapshot,answer:input=>rpc(sendDecision,input),ask:(input)=>rpc(askClarification,input),sent,append,loseAck:(value:boolean)=>{loseAck=value;},restart:()=>{rpc=load();}};
}

test("clarifications for two Q3s route, persist, and surface on their original open cards through public RPCs",async()=>{
  const f=await fixture();
  const initial=await f.snapshot();
  const source=initial.trackedDecisions.items;
  expect(source).toHaveLength(2);
  const input=source.map(item=>{
    const card:ClarificationCard={kind:"tracked",source:item.source,projectId:item.projectId,id:item.id,fingerprint:item.fingerprint};
    return {card,recipientId:item.sessionId,question:"Which audio sample supports Q3?",requestKey:"fixture-question-"+item.id};
  });
  const editor=await f.ask(input[0]);
  expect((await f.ask(input[0])).messageId).toBe(editor.messageId);
  f.loseAck(true);
  await expect(f.ask(input[1])).rejects.toThrow();
  f.loseAck(false);
  f.restart();
  const writer=await f.ask(input[1]);
  expect(writer.messageId).not.toBe(editor.messageId);
  expect(f.sent.map(m=>m.id)).toEqual(["editor","writer"]);
  for(const [index,m] of f.sent.entries()) {
    expect(m.text).toContain(source[index].id);
    expect(m.text).toContain(source[index].fingerprint);
    expect(m.text).toContain(source[index].sessionId);
    expect(m.text).toContain("Q3");
    expect(m.text).toContain(input[index].question);
  }
  let board=await f.snapshot();
  expect(board.trackedDecisions.items.map(c=>c.id)).toEqual(source.map(c=>c.id));
  expect(board.clarifications.map(q=>q.cardKey).sort()).toEqual(input.map(i=>clarificationKey(i.card)).sort());
  expect(board.clarifications.every(q=>q.status==="sent" && !q.response)).toBe(true);
  f.append("writer",{type:"assistant_message",text:"Use the **second clip** for the narration."});
  f.append("editor",{type:"assistant_message",text:"The first clip shows the edit."});
  board=await f.snapshot();
  for(const [index,response] of ["The first clip shows the edit.","Use the **second clip** for the narration."].entries()){
    const matching=board.clarifications.filter(q=>q.cardKey===clarificationKey(input[index].card));
    expect(matching).toHaveLength(1);
    expect(matching[0]).toMatchObject({response,recipientId:source[index].sessionId,question:input[index].question});
  }
  expect(board.trackedDecisions.items.map(c=>c.fingerprint)).toEqual(source.map(c=>c.fingerprint));
  expect(board.replyHistory ?? []).toBeEmpty();
  f.restart();
  expect((await f.snapshot()).clarifications).toEqual(board.clarifications);
});

test("an explanation in the source session keeps the original choice answerable until the person chooses or the conversation moves on",async()=>{
  const f=await fixture();
  for(const id of ["editor","writer"]) f.append(id,{type:"assistant_message",text:"Q3. Shall I keep the original cutoff?"});
  const original=await f.snapshot();
  const before=(id:string)=>original.sessions.find(row=>row.id===id).decision;
  for(const id of ["editor","writer"]) {
    const source=before(id);
    await f.ask({card:{kind:"session",projectId:"studio",sessionId:id,version:source.version},
      recipientId:id,question:"What is the current value?",requestKey:"fixture-native-question-"+id});
    f.append(id,{type:"assistant_message",text:"The current value is 0.04 seconds."});
  }
  const explained=await f.snapshot();
  expect(explained.clarifications).toHaveLength(2);
  for(const id of ["editor","writer"]) expect(explained.sessions.find(row=>row.id===id).decision).toEqual(before(id));
  const answer=(id:string)=>f.answer({projectId:"studio",sessionId:id,recipientId:id,version:before(id).version,
    action:"reply",text:"Use 0.10 seconds.",requestKey:"fixture-native-answer-"+id});
  f.append("writer",{type:"user_message",text:"A separate studio request.",clientMessageId:"other-event"});
  const later=await f.snapshot();
  expect(later.sessions.find(row=>row.id==="writer").decision?.version).not.toBe(before("writer").version);
  await expect(answer("writer")).rejects.toThrow();
  const final=await answer("editor");
  expect(final.recipientId).toBe("editor");
  expect(f.sent.map(m=>m.id)).toEqual(["editor","writer","editor"]);
  expect((await f.snapshot()).replyHistory?.some(r=>r.answer==="Use 0.10 seconds.")).toBe(true);
});
