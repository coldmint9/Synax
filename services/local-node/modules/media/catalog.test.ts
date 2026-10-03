import { describe, expect, it } from 'vitest';
import { mediaModels, findMediaModel, mergeMediaModelsIntoProviders } from './catalog.js';
import type { GlobalConfig, ProviderDef } from '../../infrastructure/runtime/config/config-types.js';
const config = { providers:[{id:'custom-api:openrouter',label:'OpenRouter',kind:'api',status:'live',caps:{canFollowUp:true,canCancel:true},models:[]}], providerConnections:{'custom-api:openrouter':{providerId:'custom-api:openrouter',apiKey:'key'}}, defaultProviderId:'',defaultApiProviderId:'custom-api:openrouter',enabledAcpProviderIds:[],mcpServers:[],webSearch:{} as any,limits:{maxAgentsPerProject:1,agentTimeoutMs:1},features:{allowProjectConnectionOverride:false},version:1,updatedAt:'',updatedBy:'' } as unknown as GlobalConfig;
describe('media catalog',()=>{it('exposes OpenRouter image and video presets',()=>{const ids=mediaModels(config).map(x=>x.modelId);expect(ids).toContain('openai/gpt-image-2.5-sunburst');expect(ids).toContain('bytedance/seedance-2.0');});it('keeps model ids with slashes',()=>{expect(findMediaModel(config,'custom-api:openrouter','openai/gpt-image-2.5-flare').modelId).toBe('openai/gpt-image-2.5-flare');});});
it('merges legacy media presets into the provider model directory without duplicates',()=>{const merged=mergeMediaModelsIntoProviders(config);const provider=merged.find((item)=>item.id==='custom-api:openrouter')!;const ids=provider.models.map((model)=>model.id);expect(ids).toContain('openai/gpt-image-2.5-sunburst');expect(ids).toContain('bytedance/seedance-2.0');expect(new Set(ids).size).toBe(ids.length);expect(provider.models.find((model)=>model.id==='bytedance/seedance-2.0')?.capabilities).toEqual(['video_generation']);});
it('retains configured operations and hides inactive providers',()=>{
 const provider: ProviderDef = { ...config.providers[0], models: [{ id:'multi', label:'Multi', media:{ operations:['text-to-image','text-to-video'] } }] };
 const active: GlobalConfig = { ...config, providers:[provider] };
 expect(mergeMediaModelsIntoProviders(active)[0].models.find((model)=>model.id==='multi')?.media?.operations).toEqual(['text-to-image','text-to-video']);
 const inactive: GlobalConfig = { ...config, providers:[{...provider,status:'inactive'}] };
 expect(mediaModels(inactive)).toEqual([]);
});
