import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, mkdirSync, openSync, readSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, parse } from "node:path";
import type { PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import type { SessionRow } from "../shared/contract";
import type { PullRequestView } from "../shared/prs";
import {
  resolveTrackedDecision, trackedDecisionInputSchema, trackedKey, trackedMatches,
  type TrackedDecisionInput, type TrackedDecisionView, type TrackedResolution,
} from "../shared/tracked-decisions";

const maxBytes = 8 * 1024 * 1024;
const feed = z.union([z.object({version:z.literal(1),items:z.array(z.unknown())}).transform(v=>v.items),z.array(z.unknown())]);
const receipt = z.object({key:z.string(),fingerprint:z.string().regex(/^[a-f0-9]{64}$/),at:z.string().datetime(),answer:z.string().max(4000).optional(), recipientId:z.string().optional(), messageId:z.string().uuid().optional(), pending:z.boolean().optional()});
const receipts = z.object({version:z.literal(1),items:z.array(receipt)});
type SourceStatus = TrackedDecisionView["status"];
type InputRow = {key:string;fingerprint:string;item:TrackedDecisionInput};
type Receipt = z.output<typeof receipt>;
type PendingDelivery = { ready:boolean; send:(answer:string,messageId:string)=>Promise<void>; accepted:(answer:string,messageId:string)=>Promise<boolean>; stillCurrent:()=>boolean };
type Attempt = z.output<typeof resolveTrackedDecision.output>;
type AdditionalSources = unknown[] | {items:unknown[];partial:boolean};
type ReadSources = (selected:Set<string>)=>AdditionalSources;

function receiptKey(key: string, fingerprint: string): string {
  return JSON.stringify([key, fingerprint]);
}

function readJson(path:string):{data:unknown;status:"ok"} | {status:"absent"|"invalid"|"unavailable"} {
  let fd:number|undefined;
  try {
    // Only regular files, and never allocate unbounded output for a growing export.
    fd=openSync(path,constants.O_RDONLY|constants.O_NONBLOCK|(constants.O_NOFOLLOW ?? 0));
    const stat=fstatSync(fd);
    if(!stat.isFile() || stat.size>maxBytes) return {status:"invalid"};
    const buffer=Buffer.alloc(stat.size+1);
    let length=0;
    while(length<buffer.length) {
      const count=readSync(fd,buffer,length,buffer.length-length,null);
      if(!count)break;
      length+=count;
    }
    if(length!==stat.size)return {status:"invalid"};
    return {data:JSON.parse(buffer.toString("utf8",0,length)),status:"ok"};
  } catch(error) {
    if((error as NodeJS.ErrnoException).code==="ENOENT") return {status:"absent"};
    return {status:error instanceof SyntaxError?"invalid":"unavailable"};
  } finally {if(fd!==undefined)closeSync(fd);}
}

export class TrackedDecisionStore {
  private readonly resolutionPath:string;
  constructor(private readonly path:string, private readonly readSources?:ReadSources) {
    const file=parse(path);
    this.resolutionPath=join(file.dir,file.name+".resolved.json");
  }

  private load(selected:Set<string>):{status:SourceStatus;rows:Map<string,InputRow>} {
    const rows=new Map<string,InputRow>();
    const input=readJson(this.path);
    if(input.status==="invalid" || input.status==="unavailable")return {status:input.status,rows};
    let sources:AdditionalSources;
    try{sources=this.readSources?.(new Set(selected)) ?? [];}catch{return {status:"unavailable",rows};}
    const partial=!Array.isArray(sources) && sources.partial;
    const extra=Array.isArray(sources) ? sources : sources.items;
    const raw=feed.safeParse(input.status==="ok"?input.data:[]);
    if(!raw.success || !Array.isArray(extra) || raw.data.length+extra.length>5000)return {status:"invalid",rows};
    for(const entry of [...raw.data,...extra]) {
      const parsed=trackedDecisionInputSchema.safeParse(entry);
      if(!parsed.success)return {status:"invalid",rows:new Map()};
      const item=parsed.data;
      if(item.projectId!==null && !selected.has(item.projectId))continue;
      const key=trackedKey(item);
      if(rows.has(key))return {status:"invalid",rows:new Map()};
      // An old feed without a host and a current feed explicitly marking this host are the same record.
      const fingerprint=createHash("sha256").update(JSON.stringify({...item,sessionHost:item.sessionHost ?? undefined})).digest("hex");
      rows.set(key,{key,fingerprint,item});
    }
    if(partial)return {status:"partial",rows};
    return {status:input.status==="absent" && !extra.length?"absent":"ok",rows};
  }

  private recorded():Map<string,z.output<typeof receipt>> | null {
    const input=readJson(this.resolutionPath);
    if(input.status==="absent")return new Map();
    if(input.status!=="ok")return null;
    const parsed=receipts.safeParse(input.data);
    if(!parsed.success)return null;
    const rows=new Map(parsed.data.items.map(r=>[receiptKey(r.key,r.fingerprint),r]));
    return rows.size===parsed.data.items.length?rows:null;
  }

  read(selected:Set<string>, sessions:SessionRow[], prs:PullRequestView):TrackedDecisionView {
    const {status,rows}=this.load(selected);
    if(status!=="ok" && status!=="partial")return {items:[],status};
    const resolved=this.recorded();
    if(!resolved)return {items:[],status:"unavailable"};
    const scopedSessions=sessions.filter(s=>selected.has(s.projectId));
    const scopedPrs={...prs,items:prs.items.filter(p=>p.projectIds.some(id=>selected.has(id)))};
    const items=[];
    for(const {key,fingerprint,item} of rows.values()){
      const previous=resolved.get(receiptKey(key,fingerprint));
      if(previous && !previous.pending)continue;
      items.push({...item,key,fingerprint,...trackedMatches(item,scopedSessions,scopedPrs)});
    }
    return {items,status};
  }

  resolve(input:TrackedResolution,getScope:()=>Set<string>):Attempt {
    const allowed=(scope:Set<string>)=>input.projectId===null || scope.has(input.projectId);
    const selected=getScope();
    if(!allowed(selected))return {status:"out-of-scope"};
    const data=this.load(selected);
    if(data.status==="invalid" || data.status==="unavailable")return {status:"unavailable"};
    const row=data.rows.get(trackedKey(input));
    if(!row)return {status:data.status==="partial"?"unavailable":"changed"};
    if(row.fingerprint!==input.fingerprint)return {status:"changed"};
    const records=this.recorded();
    if(!records)return {status:"unavailable"};
    if(!allowed(getScope()))return {status:"out-of-scope"};
    const version=receiptKey(row.key,row.fingerprint);
    const previous=records.get(version);
    if(previous?.pending || input.recipientId)return {status:"unconfirmed"};
    if(previous)
      return {status:input.answer && input.answer!==previous.answer?"changed":"already-closed"};
    records.set(version,{key:row.key,fingerprint:row.fingerprint,at:new Date().toISOString(),...(input.answer?{answer:input.answer}:{})});
    return this.save(records) ? {status:"closed"} : {status:"unavailable"};
  }

  private save(records:Map<string,Receipt>) {
    const body=JSON.stringify({version:1,items:[...records.values()]});
    if(Buffer.byteLength(body)>maxBytes)return false;
    const tmp=this.resolutionPath+"."+randomUUID()+".tmp";
    try {
      mkdirSync(dirname(this.resolutionPath),{recursive:true,mode:0o700});
      writeFileSync(tmp,body,{flag:"wx",mode:0o600});
      renameSync(tmp,this.resolutionPath);
    }catch{return false;}
    finally{rmSync(tmp,{force:true});}
    return true;
  }

  async deliver(input:TrackedResolution, getScope:()=>Set<string>, prepare:(row:TrackedDecisionInput)=>Promise<PendingDelivery|null>):Promise<Attempt> {
    const selected=getScope();
    if (!selected.size || (input.projectId && !selected.has(input.projectId))) return {status:"out-of-scope"};
    const key=trackedKey(input), version=receiptKey(key,input.fingerprint);
    const current=()=>this.load(getScope()).rows.get(key);
    const row=current();
    if (!row || row.fingerprint!==input.fingerprint || !input.answer || !input.recipientId) return {status:"changed"};
    const target=await prepare(row.item);
    if (!target || !target.stillCurrent() || current()?.fingerprint!==input.fingerprint) return {status:"changed"};
    const records=this.recorded();
    if (!records) return {status:"unavailable"};
    const previous=records.get(version);
    if (previous && (previous.recipientId!==input.recipientId || previous.answer!==input.answer)) return {status:"changed"};
    if (previous && !previous.pending) return {status:"sent"};
    const messageId=previous?.messageId ?? randomUUID();
    const receipt:Receipt={key,fingerprint:input.fingerprint,at:new Date().toISOString(),answer:input.answer,recipientId:input.recipientId,messageId,pending:true};
    try {
      if (previous) {
        if (!(await target.accepted(input.answer,messageId))) return {status:"unconfirmed"};
      } else {
        if (!target.ready) return {status:"busy"};
        records.set(version,receipt);
        if (!this.save(records)) return {status:"unavailable"};
        await target.send(input.answer,messageId);
      }
    } catch { return {status:"unconfirmed"}; }
    // Other decisions can be answered while the session receives this message.
    const latest=this.recorded();
    if (!latest || latest.get(version)?.messageId!==messageId) return {status:"unconfirmed"};
    latest.set(version,{...receipt,pending:false});
    return {status:this.save(latest) ? "sent" : "unconfirmed"};
  }

  register(server:PluginServerContext,getScope:()=>Set<string>,onChange?:()=>void,
    prepare?: (row:TrackedDecisionInput, target:string, ctx:import("@getpaseo/plugin/server").PluginHandlerContext)=>Promise<PendingDelivery|null>) {
    server.handle(resolveTrackedDecision,async (input,ctx)=>{
      const result=input.recipientId && prepare
        ? await this.deliver(input,getScope,row=>prepare(row,input.recipientId!,ctx))
        : this.resolve(input,getScope);
      if(result.status==="closed" || result.status==="sent")onChange?.();
      return result;
    });
  }
}
