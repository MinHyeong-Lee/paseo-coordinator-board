import { execCommand, type PluginHandlerContext, type PluginServerContext } from "@getpaseo/plugin/server";
import { stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { z } from "zod";
import { confirmPullRequestMerge, previewPullRequestMerge, pullReason, setProjectRepository,
  type MergeTarget, type PullRequestItem, type PullRequestView } from "../shared/prs";
import { githubMergeApi, PullMerges } from "./pr-merge";
import { githubRepository } from "../shared/github-repository";
export { githubRepository } from "../shared/github-repository";
import { readPages } from "./discovery";
import type { Preferences, PreferenceStore } from "./preferences";

type Sdk = Pick<PluginHandlerContext["paseo"],"projects"|"workspaces">;
type NativeProject = Awaited<ReturnType<Sdk["projects"]["list"]>>["projects"][number];
type Workspace = Awaited<ReturnType<Sdk["workspaces"]["list"]>>["entries"][number];
type ProjectView = PullRequestView["projects"][number];
type Reason = z.infer<typeof pullReason>;
type Pull = Omit<PullRequestItem,"projectIds">;
type Source = {status:"ok"|"unavailable"|"truncated"; items:Pull[]};
const scanLimit = 200;
const check = z.object({ status:z.string().nullish(), conclusion:z.string().nullish(), state:z.string().nullish() });
const rawPull = z.object({
  number:z.number().int().positive(), title:z.string(), state:z.literal("OPEN"), updatedAt:z.string().datetime({offset:true}),
  isDraft:z.boolean(), mergeable:z.string().nullable(), mergeStateStatus:z.string().nullable(), reviewDecision:z.string().nullable(),
  checks:z.array(check), autoMerge:z.boolean(),
});
const fields = "number,title,state,updatedAt,isDraft,mergeable,mergeStateStatus,reviewDecision,statusCheckRollup,autoMergeRequest";
const projection = "[.[] | {number,title,state,updatedAt,isDraft,mergeable,mergeStateStatus,reviewDecision,checks:[.statusCheckRollup[]? | {status,conclusion,state}],autoMerge:(.autoMergeRequest != null)}]";
const ttl = 60_000;

function reason(p: z.output<typeof rawPull>):Reason {
  if (p.isDraft || p.mergeStateStatus === "DRAFT") return "draft";
  if (p.mergeable === "CONFLICTING" || p.mergeStateStatus === "DIRTY") return "conflict";
  const failing = ["FAILURE","ERROR","TIMED_OUT","CANCELLED","ACTION_REQUIRED","STARTUP_FAILURE","STALE"];
  if (p.checks.some(c => failing.includes(c.conclusion || c.state || ""))) return "checks-failed";
  if (p.reviewDecision === "CHANGES_REQUESTED") return "changes-requested";
  if (p.checks.some(c => c.status ? c.status !== "COMPLETED" : ["PENDING","EXPECTED"].includes(c.state ?? ""))) return "checks-pending";
  if (p.autoMerge) return "auto-merge";
  if (p.reviewDecision === "REVIEW_REQUIRED" || ["BLOCKED","BEHIND","UNSTABLE","HAS_HOOKS"].includes(p.mergeStateStatus ?? "")) return "blocked";
  const green = ["SUCCESS","NEUTRAL","SKIPPED"];
  if (p.reviewDecision && p.reviewDecision !== "APPROVED") return "unknown";
  if (p.checks.some(c => !(c.status === "COMPLETED" && green.includes(c.conclusion ?? "")) && c.state !== "SUCCESS")) return "unknown";
  return p.mergeable === "MERGEABLE" && p.mergeStateStatus === "CLEAN" ? "ready" : "unknown";
}

export function parseOpenPulls(repo:string, json:string):Source {
  const rows = z.array(rawPull).parse(JSON.parse(json));
  const seen = new Set<number>();
  const items: Pull[] = [];
  for (const p of rows.slice(0,scanLimit)) {
    if (seen.has(p.number)) continue;
    const why = reason(p);
    items.push({repo, number:p.number, title:p.title.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g," ").slice(0,512),
      url:`https://github.com/${repo}/pull/${p.number}`, lane:why==="ready"?"review":"progress",reason:why,updatedAt:p.updatedAt});
    seen.add(p.number);
  }
  return {items,status:rows.length>scanLimit?"truncated":"ok"};
}

async function run(command:"git"|"gh", args:string[]) {
  const options = {shell:false, timeout:command==="gh"?15_000:3_000, maxBuffer:2*1024*1024,
    env:{...process.env, GH_PROMPT_DISABLED:"1", GH_NO_UPDATE_NOTIFIER:"1", GIT_TERMINAL_PROMPT:"0"}};
  try {return (await execCommand(command,args,options)).stdout;}
  catch(error) {
    if (process.platform !== "darwin" || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    for (const directory of ["/opt/homebrew/bin","/usr/local/bin","/usr/bin"]) {
      try {return (await execCommand(join(directory,command),args,options)).stdout;}
      catch (next) { if ((next as NodeJS.ErrnoException).code !== "ENOENT") throw next; }
    }
    throw error;
  }
}

async function localOrigin(path:string):Promise<string|null> {
  if (!isAbsolute(path)) return null;
  try {
    // A nested non-Git folder otherwise inherits a parent repository from git -C.
    const marker = await stat(join(path,".git"));
    if (!marker.isFile() && !marker.isDirectory()) return null;
    return githubRepository(await run("git",["-C",path,"remote","get-url","origin"]));
  } catch { return null; }
}

const githubPulls = async (repo:string) => parseOpenPulls(repo,await run("gh",[
  "pr","list","--repo","github.com/"+repo,"--state","open","--limit",String(scanLimit+1),"--json",fields,"--jq",projection,
]));

type Mapping = {mode:"auto"|"manual"|"off";repo:string|null};
function mapping(scope:Preferences, id:string):Mapping {
  const saved=Object.hasOwn(scope.projectRepositories,id)?scope.projectRepositories[id]:undefined;
  return {mode:saved?.mode??"auto",repo:saved?.mode==="manual"?saved.repo:null};
}
const equal = (a:Mapping,b:Mapping) => a.mode===b.mode && a.repo===b.repo;

export class ProjectPullRequests {
  private readonly sources = new Map<string,{expires:number; value:Promise<Source>}>();
  private readonly discovery = new Map<string,{expires:number; value:Promise<string|null>}>();
  private readonly waiting: (() => void)[] = [];
  private running = 0;
  constructor(private store:PreferenceStore,private readonly deps = {localOrigin,githubPulls,now:Date.now},
    private readonly mergeApi=githubMergeApi(args=>run("gh",args))) {}

  private async limited<T>(task:()=>Promise<T>):Promise<T> {
    if (this.running >= 3) await new Promise<void>(resolve=>this.waiting.push(resolve));
    else this.running++;
    try { return await task(); }
    finally {
      const next=this.waiting.shift();
      if (next) next();
      else this.running--;
    }
  }

  register(server:PluginServerContext,onInvalidated?:()=>void) {
    const merges=new PullMerges(this.mergeApi,this.deps.now,repo=>{this.sources.delete(repo);onInvalidated?.();});
    server.handle(previewPullRequestMerge,(input,{paseo})=>merges.preview(input,()=>this.mergeScope(paseo,input)));
    server.handle(confirmPullRequestMerge,(input,{paseo})=>merges.confirm(input,()=>this.mergeScope(paseo,input)));
    server.handle(setProjectRepository,async input=>{
      this.store.change(s=>{
        if (!s.projects.includes(input.projectId)) throw Error("관리할 프로젝트를 먼저 선택하세요.");
        const current=mapping(s,input.projectId);
        if (current.mode!==input.expectedMode || (current.mode==="manual" && current.repo!==input.expectedRepo)) throw Error("저장소 연결이 변경되었습니다. 새로 고쳐 주세요.");
        if (input.mode==="manual" && input.repo) s.projectRepositories[input.projectId]={mode:"manual",repo:input.repo};
        if (input.mode==="off") s.projectRepositories[input.projectId]={mode:"off"};
        if (input.mode==="auto") delete s.projectRepositories[input.projectId];
      });
      this.discovery.delete(input.projectId);
      return {ok:true as const};
    });
  }

  private async mergeScope(paseo:Sdk,target:MergeTarget) {
    const saved=this.store.read(), config=mapping(saved,target.projectId);
    if(!saved.projects.includes(target.projectId) || config.mode==="off") throw Error("scope");
    const current=()=>{
      const live=this.store.read();
      return live.projects.includes(target.projectId) && equal(config,mapping(live,target.projectId));
    };
    let repo=config.repo;
    if(config.mode==="auto"){
      const native=await paseo.projects.list();
      const project=native.projects.find(p=>p.projectId===target.projectId);
      if(!current()) throw Error("scope");
      // Bypass the browsing cache when a person is about to change a GitHub PR.
      repo=await this.discover(paseo,target.projectId,project?.projectRootPath);
    }
    if(repo!==target.repo || !current()) throw Error("scope");
    return current;
  }

  private async discover(paseo:Sdk,id:string,root:string|undefined) {
    const selected = () => {
      const scope = this.store.read();
      return scope.projects.includes(id) && mapping(scope,id).mode === "auto";
    };
    if (!selected()) return null;
    if (root) {
      const primary=await this.deps.localOrigin(root);
      if (primary) return primary;
    }
    if (!selected()) return null;
    const rows = await readPages<Workspace>(page=>paseo.workspaces.list({filter:{projectId:id,includeBackground:true},sort:[{key:"project_id",direction:"asc"}],page}));
    const repos = new Set<string>();
    const paths = new Set<string>();
    for (const w of rows) {
      if(w.projectId!==id || w.archivingAt || w.internal) continue;
      const checkout=w.project?.checkout;
      const remote = githubRepository(w.gitRuntime?.remoteUrl);
      const checkoutRemote = githubRepository(checkout?.remoteUrl);
      if (remote) repos.add(remote);
      if (checkoutRemote) repos.add(checkoutRemote);
      if (!remote && !checkoutRemote)
        for (const path of [w.workspaceDirectory,checkout?.cwd,checkout?.mainRepoRoot,w.projectRootPath])
        if (path && path!==root) paths.add(path);
    }
    for (const path of paths) {
      if (!selected()) return null;
      const repo=await this.deps.localOrigin(path);
      if (repo) repos.add(repo);
    }
    return repos.size===1?[...repos][0]:null;
  }

  private resolve(paseo:Sdk,id:string,root:string|undefined,refresh:boolean) {
    const existing=this.discovery.get(id), now=this.deps.now();
    if(existing && existing.expires > now && (!refresh || existing.expires === Infinity))return existing.value;
    const entry={expires:Infinity,value:this.limited(()=>this.discover(paseo,id,root))};
    this.discovery.set(id,entry);
    entry.value.then(()=>{entry.expires=this.deps.now()+ttl;},()=>{if(this.discovery.get(id)===entry)this.discovery.delete(id);});
    return entry.value;
  }

  private pulls(repo:string,refresh:boolean,stillAllowed:()=>boolean) {
    const existing=this.sources.get(repo), now=this.deps.now();
    if(existing && existing.expires>now && (!refresh || existing.expires === Infinity))return existing.value;
    const entry={expires:Infinity,value:this.limited(async():Promise<Source>=>{
      if (!stillAllowed()) return {status:"unavailable",items:[]};
      try {return await this.deps.githubPulls(repo);}
      catch {return {status:"unavailable",items:[]};}
    })};
    this.sources.set(repo,entry);
    void entry.value.then(value=>{entry.expires=this.deps.now()+(value.status==="unavailable"?15_000:ttl);});
    return entry.value;
  }

  async read(paseo:Sdk,options:{refresh?:boolean; projects?:NativeProject[]}={}):Promise<PullRequestView> {
    const selected=this.store.read(), ids=selected.projects;
    const now = this.deps.now();
    for (const [key,entry] of this.sources) if (entry.expires <= now) this.sources.delete(key);
    for (const [key,entry] of this.discovery) if (entry.expires <= now || !ids.includes(key)) this.discovery.delete(key);
    if (!ids.length) return {items:[],projects:[]};
    const refresh=options.refresh===true;
    const needsProjects = ids.some(id=>mapping(selected,id).mode==="auto");
    const native = options.projects ?? (needsProjects ? await paseo.projects.list().then(result=>result.projects,()=>null) : []);
    const roots=new Map((native ?? []).map(p=>[p.projectId,p.projectRootPath]));
    const configs=new Map(ids.map(id=>[id,mapping(selected,id)]));
    const projects=await Promise.all(ids.map(async(projectId):Promise<ProjectView>=>{
      const {mode,repo}=configs.get(projectId)!;
      if(mode==="off")return {projectId,mode,repo:null,status:"off"};
      try {
        const resolved=mode==="manual"?repo:await this.resolve(paseo,projectId,roots.get(projectId),refresh);
        return {projectId,mode,repo:resolved,status:resolved?"ok":native===null?"unavailable":"unmapped"};
      } catch {return {projectId,mode,repo:null,status:"unavailable"};}
    }));
    const allowed=(p:ProjectView,s:Preferences)=>s.projects.includes(p.projectId) && equal(configs.get(p.projectId)!,mapping(s,p.projectId));
    const byRepo=new Map<string,ProjectView[]>();
    const current=this.store.read();
    for(const p of projects)if(p.repo && allowed(p,current)) byRepo.set(p.repo,[...(byRepo.get(p.repo)??[]),p]);
    const repos=await Promise.all([...byRepo].map(async([repo,connected])=>{
      const data=await this.pulls(repo,refresh,()=>{
        const now=this.store.read();
        return connected.some(p=>allowed(p,now));
      });
      return {data,connected};
    }));
    const latest=this.store.read(), items:PullRequestItem[]=[];
    for(const {data,connected} of repos) {
      const projectIds=connected.filter(p=>allowed(p,latest)).map(p=>p.projectId);
      if(!projectIds.length) continue;
      for(const p of connected)p.status=data.status;
      items.push(...data.items.map(p=>({...p,projectIds})));
    }
    items.sort((a,b)=>b.updatedAt.localeCompare(a.updatedAt)||a.repo.localeCompare(b.repo)||b.number-a.number);
    return {items,projects:projects.filter(p=>allowed(p,latest))};
  }
}
