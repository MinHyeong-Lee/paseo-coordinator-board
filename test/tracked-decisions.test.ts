import {afterEach, expect, test} from "bun:test";
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {TrackedDecisionStore} from "../server/tracked-decisions";
import {resolveTrackedDecision, trackedCoverage, trackedDecisionViewSchema} from "../shared/tracked-decisions";
import type {SessionRow} from "../shared/contract";
import type {PullRequestView} from "../shared/prs";

const directories:string[]=[];
afterEach(()=>{for(const dir of directories.splice(0))rmSync(dir,{recursive:true,force:true});});
const row=(id:string,extra={})=>({source:"feed",projectId:"p",id,title:"Title",...extra});
const match={projectId:"p",sessionId:"s",question:"Which header?"};
const s:SessionRow={id:"s",title:"Session",projectId:"p",projectTitle:"Test",workspaceTitle:"Main",model:null,lane:"human",detail:"Earlier draft",
  decision:{question:match.question,version:"current",source:"coordinator"}};
const target={repo:"demo/repo",number:42};
const pr={...target,title:"PR",url:"https://github.com/demo/repo/pull/42",updatedAt:"",lane:"review",reason:"ready",projectIds:["p"]} as const;
function fixture(extra?:ConstructorParameters<typeof TrackedDecisionStore>[1]){
  const dir=mkdtempSync(join(tmpdir(),"coordinator-tracked-"));directories.push(dir);
  const path=join(dir,"tracked-decisions.json"), service=new TrackedDecisionStore(path,extra);
  const selected=new Set(["p"]);
  const write=(items:unknown[])=>writeFileSync(path,JSON.stringify({version:1,items}));
  const read=(sessions:SessionRow[]=[s],pulls:PullRequestView["items"]=[{...pr,projectIds:["p"]}])=>service.read(selected,sessions,{items:pulls,projects:[]});
  const close=(item,answer?:string)=>service.resolve(resolveTrackedDecision.input.parse({
    source:item.source,projectId:item.projectId,id:item.id,fingerprint:item.fingerprint,answer,
  }),()=>new Set(selected));
  return {dir,path,service,selected,write,read,close};
}

test("two decisions in one session, explicit globals and rich content survive normalizing; unselected rows are hidden",()=>{
  const f=fixture();
  const rich=row("a",{sessionId:"s",sessionMatch:match,questions:[{id:"q",text:"Pick one",multi:true,options:[{key:"a",text:"A",recommended:true,
    does:["one","two"],pros:"faster",cons:["uses bandwidth"],note:"note"}]}],qa:[{q:"yesterday",a:"yes",askedAt:"then"}],replyHistory:[{text:"answer",at:"now"}]});
  f.write([rich,row("b",{sessionId:"s"}),row("a",{source:"another"}),row("a",{projectId:null}),row("hidden",{projectId:"x"})]);
  const view=trackedDecisionViewSchema.parse(f.read());
  expect(view.items.map(i=>[i.source,i.projectId,i.id])).toEqual([["feed","p","a"],["feed","p","b"],["another","p","a"],["feed",null,"a"]]);
  expect(new Set(view.items.map(i=>i.key)).size).toBe(4);
  expect(view.items[0]).toMatchObject({matchedSessionId:"s",questions:[{id:"q",multi:true,options:[{does:"one\ntwo",pros:"faster"}]}],qa:[{a:"yes"}],replyHistory:[{at:"now"}]});
  expect(view.items[1].matchedSessionId).toBeNull();
  f.selected.clear();expect(f.read().items.map(i=>i.projectId)).toEqual([null]);
});

test("suppression requires a ready same-repo PR or a live exact matching question with both projects included",()=>{
  const f=fixture();f.selected.add("other");
  const rows=[row("cross",{projectId:"other",sessionMatch:match}),row("merge",{kind:"merge",mergeTarget:target})];
  f.write(rows);
  const current=f.read();expect(trackedCoverage(current.items)).toEqual({sessionIds:new Set(["s"]),pullKeys:new Set(["demo/repo#42"])});
  for(const change of [{id:"renamed"},{projectId:"other"},{nativePending:true},{decisionAnswered:true},{lane:"review"},
    {decision:{...s.decision,source:"permission"}},{decision:{...s.decision,question:"Which header? Extra text."}}]){
    const result=f.read([{...s,...change}]);
    expect(result.items[0].matchedSessionId).toBeNull();
  }
  f.selected.delete("p");expect(f.read().items[0].matchedSessionId).toBeNull();
  f.selected.add("p");
  for(const diff of [{projectIds:["other"]},{repo:"elsewhere/repo"},{number:43},{reason:"draft",lane:"progress"}]){
    const view=f.read([s],[{...pr,projectIds:["p"],...diff}]);expect(view.items[1].matchedPull).toBeNull();
  }
  expect(f.read([s],[]).items).toHaveLength(2);
  f.write([row("remote",{sessionId:"s",sessionHost:"remote-device",sessionMatch:match})]);
  expect(f.read().items[0]).toMatchObject({sessionHost:"remote-device",matchedSessionId:null});
  f.write([row("merely-linked",{kind:"check",mergeTarget:target})]);expect(f.read().items[0].matchedPull).toBeNull();
});

test("resolving a fingerprint records the actual answer and time locally, preserves feed bytes and reopens changed content",()=>{
  const f=fixture();f.write([row("a"),row("b")]);
  const initial=f.read().items[0], bytes=readFileSync(f.path);
  expect(f.close(initial,"Keep blue").status).toBe("closed");
  expect(f.close(initial,"Keep blue").status).toBe("already-closed");
  expect(f.close(initial,"Make purple").status).toBe("changed");
  const receipt=JSON.parse(readFileSync(join(f.dir,"tracked-decisions.resolved.json"),"utf8")).items[0];
  expect(receipt).toMatchObject({answer:"Keep blue",key:initial.key,fingerprint:initial.fingerprint});
  expect(Number.isFinite(Date.parse(receipt.at))).toBe(true);
  expect(readFileSync(f.path)).toEqual(bytes);expect(f.read().items.map(i=>i.id)).toEqual(["b"]);
  const reload=new TrackedDecisionStore(f.path);expect(reload.read(f.selected,[],{items:[],projects:[]}).items.map(i=>i.id)).toEqual(["b"]);
  f.write([row("a",{recommend:["New proposal"]}),row("b")]);
  const newRow=f.read().items[0];expect(newRow.fingerprint).not.toBe(initial.fingerprint);
  expect(f.close(initial).status).toBe("changed");
  f.selected.clear();expect(f.close(newRow).status).toBe("out-of-scope");
});

test("file and selected external sources compose, with malformed, missing, stale, or duplicate sources failing closed",()=>{
  let entries:unknown[]=[row("adapter",{sessionMatch:match})], broken=false;
  const f=fixture(selected=>{expect(selected.has("p")).toBe(true);if(broken)throw Error("private path");return entries;});
  const initial=f.read().items[0];expect(initial.id).toBe("adapter");expect(f.read().status).toBe("ok");
  f.write([row("local")]);expect(f.read().items.map(i=>i.id)).toEqual(["local","adapter"]);
  entries.push(row("local"));expect(f.read()).toEqual({items:[],status:"invalid"});expect(f.close(initial).status).toBe("unavailable");
  broken=true;expect(f.read()).toEqual({items:[],status:"unavailable"});expect(f.close(initial).status).toBe("unavailable");
  broken=false;entries=[row("adapter",{title:"changed externally"})];expect(f.close(initial).status).toBe("changed");
  writeFileSync(f.path,"{");expect(f.read()).toEqual({items:[],status:"invalid"});
  rmSync(f.path);entries=[];expect(f.read()).toEqual({items:[],status:"absent"});
  f.write([row("a")]);writeFileSync(join(f.dir,"tracked-decisions.resolved.json"),"{");
  expect(f.read()).toEqual({items:[],status:"unavailable"});
});

test("v1 receipts remain readable and retain both answers when the same decision ID is revised",()=>{
  const f=fixture();
  const old=row("a",{title:"First question"});
  f.write([old]);
  const first=f.read().items[0];
  const previous={key:first.key,fingerprint:first.fingerprint,at:"2026-01-01T00:00:00.000Z",answer:"First answer"};
  const path=join(f.dir,"tracked-decisions.resolved.json");
  writeFileSync(path,JSON.stringify({version:1,items:[previous]}));
  expect(f.read().items).toHaveLength(0);
  f.write([{...old,sessionHost:null}]);
  expect(f.read().items).toHaveLength(0);
  f.write([row("a",{title:"Second question"})]);
  const second=f.read().items[0];
  expect(f.close(second,"Second answer").status).toBe("closed");
  const saved=JSON.parse(readFileSync(path,"utf8")).items;
  expect(saved).toHaveLength(2);
  expect(saved[0]).toEqual(previous);
  expect(saved[1]).toMatchObject({key:second.key,fingerprint:second.fingerprint,answer:"Second answer"});
  expect(f.close(second,"Second answer").status).toBe("already-closed");
  f.write([old]);
  expect(f.read().items).toHaveLength(0);
  expect(f.close(first,"A different answer").status).toBe("changed");
  writeFileSync(path,JSON.stringify({version:1,items:[previous,previous]}));
  expect(f.read().status).toBe("unavailable");
});

test("an unavailable source preserves healthy cards and never acknowledges a missing or conflicting decision",()=>{
  let partial=false,conflicting=false;
  const f=fixture(()=>({
    items: partial ? [row("healthy"),...(conflicting?[row("healthy")]:[])] : [row("healthy"),row("lost")],
    partial,
  }));
  const [healthy,lost]=f.read().items;
  expect(f.read().status).toBe("ok");
  partial=true;
  f.write([row("local")]);
  const result=trackedDecisionViewSchema.parse(f.read());
  expect(result.status).toBe("partial");
  expect(result.items.map(i=>i.id)).toEqual(["local","healthy"]);
  expect(f.close(lost).status).toBe("unavailable");
  expect(f.close(healthy).status).toBe("closed");
  expect(f.close(healthy).status).toBe("already-closed");
  conflicting=true;
  expect(f.read().status).toBe("invalid");
  expect(f.close(healthy).status).toBe("unavailable");
});

test("only the local resolution RPC is exposed and a failed scope check or stale version cannot acknowledge content",async()=>{
  const f=fixture();f.write([row("a",{ask:["Deploy it"]})]);const item=f.read().items[0];
  const map=new Map(),calls:string[]=[];let changes=0;
  f.service.register({handle:(def,fn)=>{map.set(def.name,fn);calls.push(def.name);}},()=>f.selected,()=>changes++);
  expect(calls).toEqual([resolveTrackedDecision.name]);
  const input={source:item.source,projectId:item.projectId,id:item.id,fingerprint:item.fingerprint};
  expect(resolveTrackedDecision.input.safeParse({...input,answer:"x".repeat(4001)}).success).toBe(false);
  f.selected.clear();expect((await map.get(calls[0])(input,{})).status).toBe("out-of-scope");expect(changes).toBe(0);
  f.selected.add("p");expect((await map.get(calls[0])(input,{})).status).toBe("closed");expect(changes).toBe(1);
});
