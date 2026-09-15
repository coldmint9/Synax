import { describe, expect, it } from 'vitest';
import { contextGrowthP95, readContextEpochState } from '../context-epoch-store.js';
import type { AgentRunStep } from '../contracts.js';
const step=(tokens:number,changed=false):AgentRunStep=>({id:String(tokens),runId:'run',sessionId:'session',index:1,status:'completed',startedAt:'',completedAt:'',finishReason:'stop',model:'fixture',metadata:{contextCompaction:{epoch:1,compacted:false,configurationChanged:changed},contextComposition:{total:tokens}}} as AgentRunStep);
describe('epoch observation accounting',()=>{
  it('leaves incomplete growth evidence unknown and resets at configuration changes',()=>{
    expect(contextGrowthP95([step(100),step(200)],1)).toBeUndefined();
    expect(contextGrowthP95([step(100),step(200),step(400),step(500)],1)).toBe(200);
    expect(contextGrowthP95([step(100),step(200),step(400),step(90000,true),step(91000)],1)).toBeUndefined();
  });
  it('rejects malformed legacy counters without treating them as a known epoch',()=>{
    expect(readContextEpochState({version:1,epoch:-1,committedRequestCount:8})).toEqual({version:1,epoch:0,committedRequestCount:0});
    expect(readContextEpochState(undefined).epoch).toBe(0);
  });
});
