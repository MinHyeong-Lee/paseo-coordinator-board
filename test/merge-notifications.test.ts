import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TrackedDecisionStore } from "../server/tracked-decisions";
import { PreferenceStore } from "../server/preferences";
import { MergeNotifications } from "../server/merge-notifications";
import type { PullMergeActivity } from "../shared/prs";

const paths:string[] = [];
afterEach(()=>{for(const path of paths.splice(0)) rmSync(path,{recursive:true,force:true});});
const target = {projectId:"test-project",repo:"team/sample",number:27};
const entry:PullMergeActivity = {projectId:target.projectId,title:"Pull title",at:"2026-11-22T12:00:00.000Z",
  pullMerge:{repo:target.repo,number:target.number,status:"merged",mergeSha:"a".repeat(40)}};
const key = "merge:team/sample#27";

function fixture() {
  const path = mkdtempSync(join(tmpdir(),"coord-notify-")); paths.push(path);
  const store = new PreferenceStore(join(path,"scope.json"));
  store.change(s=>{s.projects=[target.projectId];s.coordinator="configured";});
  const control = { recipient:"ledger-owner" as string|null, repo:true, busy:false, lost:false, retired:false,
    permission:false, placement:target.projectId, refresh:async()=>{}, send:async()=>{} };
  const sent:{id:string;text:string;options:any}[]=[];
  const sdk={agents:{ref:(id:string)=>({refresh:async()=>{
    await control.refresh();
    return {project:{projectKey:control.placement}, agent:{id,status:control.busy?"running":"idle",archivedAt:control.retired?"now":null,
      pendingPermissions:control.permission?[{}]:[]}};
  },send:async(text:string,options:any)=>{
    expect(store.read().pullMergeHistory[key].pullMerge.notification?.status).toBe("unconfirmed");
    sent.push({id,text,options}); await control.send();
    if(control.lost) throw Error("lost acknowledgement or unsupported source");
  }})}};
  const make=()=>new MergeNotifications(store,()=>control.recipient,async()=>()=>control.repo);
  const notices=make(); const owner=notices.owner(target);
  return {store,control,sent,sdk,make,owner,notices,notify:()=>notices.confirmed(sdk,entry,owner)};
}
test("the confirmed merge sends one sourced turn to the ledger owner and retains the receipt", async()=>{
  const f=fixture();
  const [a,b]=await Promise.all([f.notify(),f.notify()]);
  expect(a).toEqual({status:"sent",recipientId:"ledger-owner"});
  expect(["queued","unconfirmed","sent"]).toContain(b.status);
  await f.make().resume(f.sdk);
  expect(f.sent).toHaveLength(1);
  expect(f.sent[0].options).toMatchObject({sourceAgentId:"plugin:coordinator-board",activeTurnBehavior:"steer"});
  expect(f.sent[0].options.messageId).toMatch(/^[\da-f-]{36}$/);
  expect(f.sent[0].text).toContain("https://github.com/team/sample/pull/27");
  expect(f.sent[0].text).toContain(entry.pullMerge.mergeSha!);
  expect(f.sent[0].text).toContain(target.projectId);
  expect(f.store.read().pullMergeHistory[key].pullMerge.notification).toEqual(a);
});
test("busy or permission-waiting recipients get at most one turn after becoming idle across a restart", async()=>{
  const f=fixture(); f.control.busy=true;
  expect((await f.notify()).status).toBe("queued");
  f.control.busy=false; f.control.permission=true;
  const restarted=f.make();
  await restarted.resume(f.sdk,"ledger-owner");
  f.control.permission=false;
  await restarted.resume(f.sdk,"different-coordinator");
  expect(f.sent).toHaveLength(0);
  await Promise.all([restarted.resume(f.sdk),restarted.resume(f.sdk,"ledger-owner")]);
  expect(f.sent).toHaveLength(1);
  expect(f.store.read().pullMergeHistory[key].pullMerge.notification.status).toBe("sent");
});
test("rotation during target validation, invalid ownership and a project remap never notify another session", async()=>{
  for (const change of [
    f=>{f.control.refresh=async()=>{f.control.recipient="rotated";};},
    f=>{f.control.recipient=null;},
    f=>{f.control.repo=false;},
    f=>{f.control.placement="unmanaged";},
    f=>{f.control.retired=true;},
    f=>{f.control.refresh=async()=>{f.store.change(s=>{s.coordinator="replacement";});};},
    f=>{f.store.change(s=>{s.projects=[];});},
  ]) {
    const f=fixture(); change(f);
    expect((await f.notify()).status).toBe("unavailable");
    expect(f.sent).toHaveLength(0);
  }
});
test("an ambiguous acknowledgement never falls back to a user prompt or sends the merge twice", async()=>{
  const f=fixture(); f.control.lost=true;
  expect((await f.notify()).status).toBe("unconfirmed");
  f.control.lost=false;
  await f.make().resume(f.sdk);
  expect((await f.notify()).status).toBe("unconfirmed");
  expect(f.sent).toHaveLength(1);
});

test("PR target ownership uses the trusted matching project ledger, and ambiguous or unreadable sources cannot fall back", ()=>{
  const path = mkdtempSync(join(tmpdir(),"coord-merge-owner-")); paths.push(path);
  const row = (source:string, owner:string|null, number:number) => ({source,id:"merge-"+number,projectId:target.projectId,
    kind:"merge",where:"manager",title:"Merge",mergeTarget:{repo:target.repo,number},sourceCoordinatorId:owner});
  const config = {items:[row("one","owner-A",27),row("two","owner-B",29)], partial:false};
  const store = new TrackedDecisionStore(join(path,"feed.json"),()=>config);
  expect(store.mergeRecipient(target,"board")).toBe("owner-A");
  expect(store.mergeRecipient({...target,number:51},"board")).toBe("board");
  config.items.push(row("other","owner-B",27));
  expect(store.mergeRecipient(target,"board")).toBeNull();
  config.items = [row("missing",null,27)];
  expect(store.mergeRecipient(target,"board")).toBeNull();
  config.partial = true;
  expect(store.mergeRecipient({...target,number:51},"board")).toBeNull();
});
