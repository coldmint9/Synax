import { createAnthropic } from '@ai-sdk/anthropic';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { HistoryCacheAnchor } from '../cache-policy.js';
import type { LlmGatewayMessage, LlmGatewayRequest, ResolvedModelSelection } from '../types.js';
const fixture = vi.hoisted(() => ({ bytes: Buffer.from('image-one'), requests: [] as Record<string, any>[] }));
vi.mock('../../agent-runtime/media-assets.js', () => ({
  getAsset: () => ({ id:'image', projectId:'project', filename:'image.png', mediaType:'image/png', size:12, sha256:'fixture', createdAt:'' }),
  readAsset: async () => fixture.bytes,
  validateAssets: vi.fn(),
}));
vi.mock('../providers/provider-cache.js', () => ({ getOrCreateClient: async () => createAnthropic({ apiKey:'local-fixture', fetch: async (_url, init) => {
  fixture.requests.push(JSON.parse(String(init?.body)));
  return new Response(JSON.stringify({ id:'msg_fixture', type:'message', role:'assistant', model:'claude-sonnet-4-5', content:[{type:'text',text:'ok'}], stop_reason:'end_turn', stop_sequence:null, usage:{input_tokens:10,output_tokens:1,cache_read_input_tokens:0,cache_creation_input_tokens:0} }), {headers:{'Content-Type':'application/json'}});
} }) }));
import { executePipeline } from '../pipeline.js';
const selection: ResolvedModelSelection = {
  providerId:'fixture', model:'fixture/model', modelId:'claude-sonnet-4-5', apiFormat:'anthropic',
  provider:{id:'fixture',label:'Fixture',npm:'@ai-sdk/anthropic',env:[],supported:true,models:[]},
  modelDef:{id:'claude-sonnet-4-5',label:'Fixture',inputModalities:['text','image']}, config:{providerId:'fixture',apiKey:'local-fixture'},
};
const reminder = (step: number): LlmGatewayMessage => ({role:'user',content:`<system-reminder>\nStep ${step}\n</system-reminder>`});
const image = (): LlmGatewayMessage => ({role:'user',content:[{type:'file',data:new URL('synax-asset:image'),mediaType:'image/png'}]});
function markedBlocks(body: Record<string, any>) {
  return body.messages.flatMap((m: any) => m.content).filter((block: any) => block.cache_control);
}
const base = {purpose:'validate',projectId:'project',cacheControl:true,maxTokens:32};
beforeEach(() => { fixture.requests.length=0; fixture.bytes=Buffer.from('image-one'); });
describe('prepared request anchor representation', () => {
  it.each([false,true])('persists and verifies hydrated media including compiled tool-media (tool=%s)', async toolMedia => {
    const media = image();
    const initial: LlmGatewayMessage[] = toolMedia ? [
      {role:'system',content:'Stable'}, {role:'user',content:'Read image'},
      {role:'assistant',content:[{type:'tool-call',toolCallId:'read',toolName:'read',input:{}}]},
      {role:'tool',content:[{type:'tool-result',toolCallId:'read',toolName:'read',output:{type:'text',value:'Image result'}}]},
      {...media,providerOptions:{synax:{toolCallId:'read'}}}, reminder(1),
    ] : [{role:'system',content:'Stable'}, media, reminder(1)];
    let anchor: HistoryCacheAnchor | undefined;
    const statuses: string[]=[];
    const prepared: NonNullable<LlmGatewayRequest['onRequestPrepared']> = info => { anchor=info.historyAnchor;statuses.push(info.historyAnchorStatus); };
    await executePipeline({...base,messages:initial,onRequestPrepared:prepared},selection,{kind:'text'});
    const next = [...initial,...Array.from({length:26},(_,n):LlmGatewayMessage=>({role:n%2?'user':'assistant',content:`new block ${n}`})),reminder(2)];
    await executePipeline({...base,messages:next,previousHistoryAnchor:anchor,onRequestPrepared:prepared},selection,{kind:'text'});
    expect(statuses).toEqual(['cold','matched']);
    expect(markedBlocks(fixture.requests[1]).some((block:any)=>toolMedia ? block.type==='tool_result' : block.type==='image')).toBe(true);
    expect(markedBlocks(fixture.requests[1]).some((block:any)=>block.text==='new block 25')).toBe(true);
    fixture.bytes=Buffer.from('image-two');
    let status='';
    await executePipeline({...base,messages:[...next,{role:'assistant',content:'more'},reminder(3)],previousHistoryAnchor:anchor,onRequestPrepared:info=>{status=info.historyAnchorStatus;}},selection,{kind:'text'});
    expect(status).toBe('changed');
  });
  it('awaits the persistence hook and never sends a request when snapshot validation fails', async () => {
    await expect(executePipeline({...base,messages:[image(),reminder(1)],onRequestPrepared:async()=>{throw new Error('request_snapshot_changed');}},selection,{kind:'text'})).rejects.toThrow('request_snapshot_changed');
    expect(fixture.requests).toHaveLength(0);
  });
});
