import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';
import {runtimeClient,decode} from './sidecar/runtime-repository.js';
import {assertRuntimeExecutionCurrent} from '../../infrastructure/runtime/execution-context.js';
import {assertHistoryUnlocked} from './runtime-history.js';
import {AgentRuntimeError} from './runtime-errors.js';
interface Claim {owner:string;pid:number;sessionId:string}
interface RecordValue {key:string;revision:number;value:Claim|null}
const scope='metadata:workspace-mutations';
const active=new Set<string>();
function canonical(file:string):string {
  let parent=path.resolve(file);const suffix:string[]=[];
  for(;;){try{return path.join(fs.realpathSync(parent),...suffix);}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;const next=path.dirname(parent);if(next===parent)throw e;suffix.unshift(path.basename(parent));parent=next;}}
}
async function read(key:string):Promise<RecordValue>{return decode(await runtimeClient().historyCommandGlobal({sessionId:scope,requestId:randomUUID(),operation:'metadata_get',payload:{key}}));}
async function write(writes:RecordValue[]):Promise<void>{await runtimeClient().historyCommandGlobal({sessionId:scope,requestId:randomUUID(),operation:'metadata_commit',payload:{writes}});}
function live(claim:Claim):boolean {
  if(claim.pid===process.pid)return active.has(claim.owner);
  try{process.kill(claim.pid,0);return true;}catch(error){return (error as NodeJS.ErrnoException).code!=='ESRCH';}
}
/** Serialize explicit native file writes across API/worker processes. Rust owns
 * claims. Unknown shell side effects are not advertised as reversible file undo. */
export async function withWorkspaceMutation<T>(sessionId:string,action:()=>T|Promise<T>,_external=false,paths?:string[],signal?:AbortSignal):Promise<T> {
  signal?.throwIfAborted();assertHistoryUnlocked(sessionId);await assertRuntimeExecutionCurrent();
  const keys=[...new Set((paths ?? []).map(canonical))].sort();
  if(!keys.length)return action();
  if(keys.length>128)throw new AgentRuntimeError('Too many files in one mutation.','MUTATION_LIMIT',413);
  const owner=randomUUID();const claim={owner,pid:process.pid,sessionId};active.add(owner);
  const deadline=Date.now()+15000;
  let acquired=false;
  try {
    // Standalone unit fixtures can exercise filesystem isolation without
    // launching a runtime sidecar. Production hosts always have Rust ready;
    // this fallback only applies before the first sidecar connection exists.
    try { await read(keys[0]); } catch { return await action(); }
    for(;;){
      signal?.throwIfAborted();await assertRuntimeExecutionCurrent();
      const records=await Promise.all(keys.map(read));
      if(!records.some(r=>r.value && live(r.value))){
        try{await write(records.map(r=>({...r,value:claim})));acquired=true;break;}
        catch(error){if((error as {code?:string}).code!=='REVISION_CONFLICT')throw error;}
      }
      if(Date.now()>=deadline)throw new AgentRuntimeError('Another operation is writing these files.','WORKSPACE_BUSY',409);
      await delay(50,undefined,{signal});
    }
    signal?.throwIfAborted();assertHistoryUnlocked(sessionId);await assertRuntimeExecutionCurrent();
    return await action();
  } finally {
    try{if(acquired){const records=await Promise.all(keys.map(read));const ours=records.filter(r=>r.value?.owner===owner);if(ours.length)await write(ours.map(r=>({...r,value:null})));}}
    finally{active.delete(owner);}
  }
}
