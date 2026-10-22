import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import {createInterface} from 'node:readline';
import {resolveLogDir} from './log-file-store.js';
import {formatLocalDay,formatLogTimestamp,LOG_RETENTION_DAYS,retentionCutoffDay} from './log-retention.js';
export type ApiLogLevel='trace'|'debug'|'info'|'warn'|'error'|'fatal';
export interface PersistApiLogInput {level:ApiLogLevel;message:string;context:Record<string,unknown>;loggedAt?:string}
export interface ApiLogEntry {id:number;day:string;loggedAt:string;level:ApiLogLevel;message:string;context:Record<string,unknown>;method:string|null;path:string|null;status:number|null;durationMs:number|null}
export interface ApiLogDailyStat {day:string;totalCount:number;traceCount:number;debugCount:number;infoCount:number;warnCount:number;errorCount:number;fatalCount:number;requestCount:number;errorRequestCount:number;lastLoggedAt:string|null}
let sequence=0,lastPrune='';
const file=(day:string)=>path.join(resolveLogDir(),`events-${day}.jsonl`);
export function persistApiLog(input:PersistApiLogInput):void {
  const loggedAt=input.loggedAt ?? formatLogTimestamp(),day=formatLocalDay(new Date(loggedAt));
  const context=input.context;const number=(v:unknown)=>typeof v==='number'&&Number.isFinite(v)?v:null;
  const row:ApiLogEntry={...input,context,loggedAt,day,id:++sequence,method:typeof context.method==='string'?context.method:null,path:typeof context.path==='string'?context.path:null,status:number(context.status),durationMs:number(context.ms??context.durationMs)};
  try{if(day!==lastPrune){pruneOldApiLogs();lastPrune=day;}fs.appendFileSync(file(day),JSON.stringify(row)+'\n',{mode:0o600});}catch(error){process.stderr.write(`Unable to persist diagnostic log: ${String(error)}\n`);}
}
export function pruneOldApiLogs(days=LOG_RETENTION_DAYS):void {
  const cutoff=retentionCutoffDay(days);
  for(const name of fs.readdirSync(resolveLogDir())){const match=/^events-(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name);if(match && match[1]<cutoff)fs.unlinkSync(path.join(resolveLogDir(),name));}
}
async function* entries(day?:string):AsyncGenerator<ApiLogEntry> {
  if(day && !/^\d{4}-\d{2}-\d{2}$/.test(day))throw new Error('Invalid log day');
  const names=(await fsp.readdir(resolveLogDir())).filter(name=>/^events-\d{4}-\d{2}-\d{2}\.jsonl$/.test(name) && (!day || name===`events-${day}.jsonl`)).sort();
  for(const name of names){const stream=fs.createReadStream(path.join(resolveLogDir(),name));const lines=createInterface({input:stream,crlfDelay:Infinity});try{for await(const line of lines){try{yield JSON.parse(line) as ApiLogEntry;}catch{/* incomplete crash tail */}}}finally{lines.close();stream.destroy();}}
}
export async function listApiLogs(input?:{day?:string;limit?:number}):Promise<ApiLogEntry[]> {
  const limit=Math.min(500,Math.max(1,input?.limit ?? 100)),result:ApiLogEntry[]=[];
  for await(const row of entries(input?.day)){result.push(row);if(result.length>limit)result.shift();}
  return result.reverse();
}
export async function listApiLogDailyStats(days=30):Promise<ApiLogDailyStat[]> {
  const stats=new Map<string,ApiLogDailyStat>();
  for await(const row of entries()){
    const stat=stats.get(row.day)??{day:row.day,totalCount:0,traceCount:0,debugCount:0,infoCount:0,warnCount:0,errorCount:0,fatalCount:0,requestCount:0,errorRequestCount:0,lastLoggedAt:null};
    stat.totalCount++;stat[`${row.level}Count`]++;if(row.method && row.path){stat.requestCount++;if((row.status??0)>=500)stat.errorRequestCount++;}stat.lastLoggedAt=row.loggedAt;stats.set(row.day,stat);
  }
  return [...stats.values()].sort((a,b)=>b.day.localeCompare(a.day)).slice(0,Math.min(LOG_RETENTION_DAYS,Math.max(1,days)));
}
export function clearApiLogStoreForTests():void {for(const name of fs.readdirSync(resolveLogDir()))if(/^events-.*\.jsonl$/.test(name))fs.unlinkSync(path.join(resolveLogDir(),name));sequence=0;}
export function closeApiLogStore():void {lastPrune='';}
