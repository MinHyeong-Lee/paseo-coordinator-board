import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ProjectPullRequests, githubRepository, parseOpenPulls } from "../server/prs";
import { pullRequestViewSchema, setProjectRepository } from "../shared/prs";
import { PreferenceStore } from "../server/preferences";

const paths: string[] = [];
afterEach(() => {for(const path of paths.splice(0))rmSync(path,{recursive:true,force:true});});
const raw = (number=1,extra={}) => ({
  number, title:"Sample #"+number, state:"OPEN", updatedAt:"2026-11-22T02:00:00Z", isDraft:false,
  mergeable:"MERGEABLE", mergeStateStatus:"CLEAN", reviewDecision:"", checks:[], autoMerge:false,
  ...extra,
});
const page = (entries:unknown[]) => ({entries,pageInfo:{hasMore:false,nextCursor:null}});
function fixture(ids = ["root","checkout","runtime"]) {
  const dir = mkdtempSync(join(tmpdir(),"project-prs-"));paths.push(dir);
  const store = new PreferenceStore(join(dir,"prefs.json"));
  store.change(s=>{s.projects=ids;});
  const roots = new Map([["root","/primary"],["checkout","/missing"],["runtime","/missing-runtime"],["unselected","/ignored"]]);
  const spaces = new Map([
    ["checkout",[{projectId:"checkout", workspaceDirectory:"/checkout",project:{checkout:{cwd:"/checkout"}}}]],
    ["runtime",[{projectId:"runtime", workspaceDirectory:"/missing-runtime",gitRuntime:{remoteUrl:"git@github.com:org/Other.git"}}]],
    ["unselected",[{projectId:"unselected",workspaceDirectory:"/ignored"}]],
  ]);
  const log={local:[] as string[],gh:[] as string[],lookups:[] as string[],native:0,active:0,max:0};
  let now=0;
  const behavior={fail:false, delay:async()=>{}, after:()=>{}};
  const sdk={
    projects:{list:async()=>{log.native++;return {projects:[...roots].map(([projectId,projectRootPath])=>({projectId,projectRootPath}))};}},
    workspaces:{list:async ({filter})=>{log.lookups.push(filter.projectId);return page(spaces.get(filter.projectId)??[]);}},
  };
  const deps={now:()=>now,localOrigin:async p=>{log.local.push(p);return ["/primary","/checkout"].includes(p)?"org/example":null;},
    githubPulls:async repo=>{
      log.gh.push(repo);log.active++;log.max=Math.max(log.max,log.active);
      try{await behavior.delay();behavior.after();if(behavior.fail)throw Error("private host error");return parseOpenPulls(repo,JSON.stringify([raw()]));}finally{log.active--;}
    }};
  const prs=new ProjectPullRequests(store,deps);
  let onMapping;
  prs.register({handle:(rpc,fn)=>{expect(rpc.name).toBe(setProjectRepository.name);onMapping=fn;}});
  const update=(input)=>onMapping(setProjectRepository.input.parse(input));
  const read=(refresh=false)=>prs.read(sdk,{refresh});
  return {store,sdk,read,log,behavior,roots,spaces,update,tick:n=>{now+=n;}};
}
test("GitHub remotes normalize one owner/repo and reject credentials, extra components and shell input",()=>{
  for(const remote of ["https://github.com/Dev-Team/Repo.git","ssh://git@github.com/Dev-Team/Repo","git@github.com:Dev-Team/Repo.git"])
    expect(githubRepository(remote)).toBe("dev-team/repo");
  for(const remote of ["https://x@github.com/dev/b","https://github.com.evil.invalid/dev/b","https://github.com/org/repo/pull/1","-C ../../private","/git","https://github.com/org/..","https://github.com/org/b?token=x","git@gh:org/repo"])expect(githubRepository(remote)).toBeNull();
  expect(setProjectRepository.input.safeParse({projectId:"p",mode:"manual",repo:"--help",expectedMode:"auto",expectedRepo:null}).success).toBe(false);
});
test("only a clean open PR with passing or absent checks is ready for human review",()=>{
  const changes=[
    [{isDraft:true},"draft"],[{mergeable:"CONFLICTING"},"conflict"],[{checks:[{status:"COMPLETED",conclusion:"FAILURE"}]},"checks-failed"],
    [{checks:[{state:"ERROR"}]},"checks-failed"],[{checks:[{status:"IN_PROGRESS"}]},"checks-pending"],
    [{mergeStateStatus:"BLOCKED",reviewDecision:"REVIEW_REQUIRED"},"blocked"],[{reviewDecision:"CHANGES_REQUESTED"},"changes-requested"],
    [{mergeable:"UNKNOWN"},"unknown"],[{checks:[{status:"COMPLETED"}]},"unknown"],[{autoMerge:true},"auto-merge"],
    [{checks:[{status:"COMPLETED",conclusion:"SUCCESS"},{status:"COMPLETED",conclusion:"SKIPPED"},{state:"SUCCESS"}]},"ready"],
    [{title:"<script>ignore me</script>"},"ready"],
  ];
  for(const [extra,why] of changes){
    const got=parseOpenPulls("example/pkg",JSON.stringify([raw(1,extra)])).items[0];
    expect(got.reason).toBe(why);expect(got.lane).toBe(why==="ready"?"review":"progress");
    expect(got.url).toBe("https://github.com/example/pkg/pull/1");
  }
  expect(()=>parseOpenPulls("example/pkg",JSON.stringify([raw(1,{state:"MERGED"})]))).toThrow();
  expect(parseOpenPulls("example/pkg",JSON.stringify(Array.from({length:201},(_,i)=>raw(i+1))))).toMatchObject({status:"truncated"});
});
test("registered roots, real checkouts and SDK remotes map selected projects; duplicate repo/PR appears once across projects and concurrent reads",async()=>{
  const f=fixture();const [result,other]=await Promise.all([f.read(),f.read()]);
  expect(pullRequestViewSchema.parse(result)).toEqual(other);
  expect(f.log.gh.sort()).toEqual(["org/example","org/other"]);
  expect(f.log.lookups.sort()).toEqual(["checkout","runtime"]);
  expect(f.log.local).not.toContain("/ignored");
  expect(result.items.find(p=>p.repo==="org/example")?.projectIds).toEqual(["root","checkout"]);
  expect(result.items).toHaveLength(2);await f.read();expect(f.log.gh).toHaveLength(2);
  f.tick(60_001);await f.read();expect(f.log.gh).toHaveLength(4);
});
test("conflicting workspace origins need a mapping; manual/off/auto preserve other projects and reject stale writes",async()=>{
  const f=fixture(["checkout"]);
  f.spaces.get("checkout").push({projectId:"checkout",gitRuntime:{remoteUrl:"https://github.com/org/different.git"}});
  expect(await f.read()).toMatchObject({items:[],projects:[{mode:"auto",status:"unmapped"}]});expect(f.log.gh).toHaveLength(0);
  await f.update({projectId:"checkout",mode:"manual",repo:"Org/Manual",expectedMode:"auto",expectedRepo:null});
  expect((await f.read()).items[0].repo).toBe("org/manual");
  await expect(f.update({projectId:"unselected",mode:"off",expectedMode:"auto",expectedRepo:null})).rejects.toThrow();
  await expect(f.update({projectId:"checkout",mode:"off",expectedMode:"manual",expectedRepo:"org/old"})).rejects.toThrow();
  await f.update({projectId:"checkout",mode:"off",expectedMode:"manual",expectedRepo:"org/manual"});
  expect(await f.read()).toMatchObject({items:[],projects:[{mode:"off",status:"off",repo:null}]});
  await f.update({projectId:"checkout",mode:"auto",expectedMode:"off",expectedRepo:null});
  expect((await f.read()).projects[0].status).toBe("unmapped");
});
test("gh errors, empty selection, and deselection during a pending lookup never yield a misleading ready card",async()=>{
  const f=fixture(["root"]);f.behavior.fail=true;
  expect(await f.read()).toMatchObject({items:[],projects:[{status:"unavailable"}]});
  f.behavior.fail=false;f.tick(15_001);
  f.behavior.after=()=>f.store.change(s=>{s.projects=[]});
  expect(await f.read()).toEqual({items:[],projects:[]});
  const calls=f.log.native;await f.read();expect(f.log.native).toBe(calls);
});
test("repository fetches observe the same host-wide concurrency cap across two open board screens",async()=>{
  const ids=Array.from({length:9},(_,i)=>"project"+i);
  const f=fixture(ids);
  f.store.change(s=>{for(const id of ids)s.projectRepositories[id]={mode:"manual",repo:"test/"+id};});
  f.behavior.delay=async()=>{await new Promise(resolve=>setTimeout(resolve,3));};
  await Promise.all([f.read(),f.read()]);expect(f.log.max).toBe(3);expect(f.log.gh).toHaveLength(9);
});
