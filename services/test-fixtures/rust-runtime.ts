import {afterAll} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {RustRuntimeSupervisor} from '../local-node/infrastructure/runtime/rust-sidecar.js';
import {businessStore,BUSINESS_COLLECTIONS} from '../local-node/infrastructure/persistence/business-store.js';
import {runtimeClient,decode} from '../local-node/modules/agent-runtime/sidecar/runtime-repository.js';
import {randomUUID} from 'node:crypto';
let supervisor:RustRuntimeSupervisor|undefined;
let root:string|undefined;
let starting:Promise<void>|undefined;
export function ensureTestRuntime():Promise<void> {
  return starting ??= (async()=>{
    root=await fs.mkdtemp(path.join(os.tmpdir(),'synax-rust-test-'));
    supervisor=new RustRuntimeSupervisor({dataRoot:root});
    await supervisor.start();
    process.env.SYNAX_RUNTIME_SIDECAR_STREAM='authoritative';
    await businessStore.refresh();
  })();
}
export async function clearBusinessTestData():Promise<void> {
  await ensureTestRuntime();await businessStore.flush();
  for(const name of BUSINESS_COLLECTIONS){
    const sessionId=`metadata:${name}`;
    let after:string|undefined;
    do {
      const page=decode<{items:Array<{key:string;revision:number;value:unknown}>;after?:string}>(await runtimeClient().historyCommandGlobal({sessionId,requestId:randomUUID(),operation:'metadata_page',payload:{after,limit:128}}));
      const writes=page.items.filter(r=>r.value!==null).map(r=>({...r,value:null}));
      if(writes.length)await runtimeClient().historyCommandGlobal({sessionId,requestId:randomUUID(),operation:'metadata_commit',payload:{writes}});
      after=page.after;
    }while(after);
  }
  await businessStore.refresh();
}
afterAll(async()=>{
  if(!supervisor)return;
  await businessStore.flush().catch(()=>{});
  await supervisor.stop();
  if(root)await fs.rm(root,{recursive:true,force:true});
});
