import type { GlobalConfig, ProviderDef } from '../../lib/config/config-types.js';
import type { MediaAdapter, MediaCapabilities, MediaModel } from './contracts.js';

const IMAGE: MediaCapabilities = { operations: ['text-to-image','image-to-image'], referenceRoles: ['reference'], maxReferences: 16, parameters: { n: { min: 1, max: 10 }, aspectRatio: {}, size: {}, quality: {} }, streaming: true };
const VIDEO: MediaCapabilities = { operations: ['text-to-video','image-to-video'], referenceRoles: ['first_frame','last_frame','reference'], maxReferences: 9, parameters: { duration: { min: 1, max: 30 }, resolution: {}, aspectRatio: {}, generateAudio: {} }, polling: true, cancellation: true };
const BUILTINS: Array<{ providerId: string; adapter: MediaAdapter; label: string; models: Array<{ id: string; label: string; capabilities: MediaCapabilities }> }> = [
 { providerId:'openai', adapter:'openai', label:'OpenAI', models:[{id:'gpt-image-2.5-sunburst',label:'GPT Image 2.5 Sunburst',capabilities:IMAGE},{id:'gpt-image-2.5-flare',label:'GPT Image 2.5 Flare',capabilities:IMAGE}] },
 { providerId:'custom-api:xai', adapter:'xai', label:'xAI', models:[{id:'grok-imagine-image-2.0',label:'Grok Imagine Image 2.0',capabilities:IMAGE},{id:'grok-imagine-video-1.5',label:'Grok Imagine Video 1.5',capabilities:VIDEO}] },
 { providerId:'custom-api:ark', adapter:'ark', label:'ByteDance / Ark', models:[{id:'seedance-2.0',label:'Seedance 2.0',capabilities:VIDEO},{id:'seedance-2.5',label:'Seedance 2.5',capabilities:VIDEO}] },
 { providerId:'custom-api:minimax', adapter:'minimax', label:'MiniMax', models:[{id:'MiniMax-H3',label:'MiniMax H3',capabilities:VIDEO},{id:'MiniMax-H3-Max',label:'MiniMax H3 Max',capabilities:VIDEO}] },
 { providerId:'custom-api:openrouter', adapter:'openrouter', label:'OpenRouter', models:[{id:'openai/gpt-image-2.5-sunburst',label:'GPT Image 2.5 Sunburst',capabilities:IMAGE},{id:'openai/gpt-image-2.5-flare',label:'GPT Image 2.5 Flare',capabilities:IMAGE},{id:'x-ai/grok-imagine-image-2.0',label:'Grok Imagine Image 2.0',capabilities:IMAGE},{id:'x-ai/grok-imagine-video-1.5',label:'Grok Imagine Video 1.5',capabilities:VIDEO},{id:'bytedance/seedance-2.0',label:'Seedance 2.0',capabilities:VIDEO},{id:'minimax/hailuo-3',label:'MiniMax Hailuo 3',capabilities:VIDEO}] },
];
export function mediaModels(config: GlobalConfig, providers = config.providers): MediaModel[] {
 const configured = new Set(providers.filter(p=>p.kind==='api').map(p=>p.id));
 const result: MediaModel[] = [];
 for (const preset of BUILTINS) if (configured.has(preset.providerId)) for (const model of preset.models) result.push({ providerId:preset.providerId, modelId:model.id, label:model.label, providerLabel:preset.label, adapter:preset.adapter, capabilities:model.capabilities });
 for (const provider of providers.filter(p=>p.kind==='api')) {
   const adapter = (config.providerConnections[provider.id]?.mediaAdapter ?? adapterFor(provider.id)) as MediaAdapter | undefined;
   if (!adapter) continue;
   for (const model of provider.models) if (model.media) result.push({providerId:provider.id,modelId:model.id,label:model.label,providerLabel:provider.label,adapter,capabilities:model.media});
 }
 return result;
}
export function adapterFor(providerId: string): MediaAdapter | undefined { if(providerId==='openai') return 'openai'; if(providerId.includes('openrouter')) return 'openrouter'; if(providerId.includes('xai')) return 'xai'; if(providerId.includes('ark')||providerId.includes('volc')) return 'ark'; if(providerId.includes('minimax')) return 'minimax'; return undefined; }
export function findMediaModel(config: GlobalConfig, providerId: string, modelId: string): MediaModel {
 const found = mediaModels(config).find(m=>m.providerId===providerId && m.modelId===modelId);
 if (found) return found;
 const provider = config.providers.find(p=>p.id===providerId);
 const adapter = config.providerConnections[providerId]?.mediaAdapter ?? adapterFor(providerId);
 if (!provider || !adapter) throw new Error(`Media provider '${providerId}' is not configured.`);
 const media = provider.models.find(m=>m.id===modelId)?.media;
 if (!media) throw new Error(`Media model '${modelId}' is not configured for '${providerId}'.`);
 return {providerId,modelId,label:modelId,providerLabel:provider.label,adapter,capabilities:media};
}
export async function discoverOpenRouterModels(baseUrl: string, apiKey: string): Promise<MediaModel[]> {
 const headers = { authorization: `Bearer ${apiKey}` };
 const result: MediaModel[] = [];
 const [images, videos] = await Promise.all([
  fetch(`${baseUrl.replace(/\/$/,'')}/images/models`, { headers }).then(r=>r.ok?r.json():{data:[]}).catch(()=>({data:[]})),
  fetch(`${baseUrl.replace(/\/$/,'')}/videos/models`, { headers }).then(r=>r.ok?r.json():{data:[]}).catch(()=>({data:[]})),
 ]);
 for (const item of images.data ?? []) result.push({ providerId:'custom-api:openrouter', modelId:item.id, label:item.name ?? item.id, providerLabel:'OpenRouter', adapter:'openrouter', capabilities:{ operations:['text-to-image','image-to-image'], referenceRoles:['reference'], maxReferences:item.supported_parameters?.input_references?16:0, parameters:item.supported_parameters ?? {}, streaming:Boolean(item.supports_streaming) } });
 for (const item of videos.data ?? []) result.push({ providerId:'custom-api:openrouter', modelId:item.id, label:item.name ?? item.id, providerLabel:'OpenRouter', adapter:'openrouter', capabilities:{ operations:['text-to-video','image-to-video'], referenceRoles:['first_frame','last_frame','reference'], maxReferences:9, parameters:{ duration:{values:item.supported_durations}, resolution:{values:item.supported_resolutions}, aspectRatio:{values:item.supported_aspect_ratios} }, polling:true, cancellation:true } });
 return result;
}
