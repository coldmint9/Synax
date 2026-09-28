import { readAsset } from '../agent-runtime/media-assets.js';
import type { GlobalConfig } from '../../lib/config/config-types.js';
import type { MediaJobInput, MediaModel, MediaJobStatus } from './contracts.js';
import { findMediaModel } from './catalog.js';

export interface SubmittedMedia { upstreamId?: string; immediate?: Array<{ bytes: Buffer; mediaType: string; filename: string }>; status: MediaJobStatus; }
export interface PolledMedia { status: MediaJobStatus; url?: string; bytes?: Buffer; mediaType?: string; error?: string; }
function connection(config: GlobalConfig, providerId: string) { const c=config.providerConnections[providerId]; if(!c?.apiKey) throw new Error(`API key for '${providerId}' is not configured.`); return { key:c.apiKey, base:(c.baseUrl ?? ({openai:'https://api.openai.com/v1', 'custom-api:xai':'https://api.x.ai/v1','custom-api:openrouter':'https://openrouter.ai/api/v1','custom-api:ark':'https://ark.cn-beijing.volces.com/api/v3','custom-api:minimax':'https://api.minimax.io'} as Record<string,string>)[providerId] ?? '').replace(/\/$/,'') }; }
function headers(key:string){return {'content-type':'application/json','authorization':`Bearer ${key}`};}
async function json(url:string, init:RequestInit, signal?:AbortSignal):Promise<any>{const r=await fetch(url,{...init,signal});const text=await r.text();let body:any;try{body=JSON.parse(text)}catch{body={message:text}}if(!r.ok)throw new Error(body?.error?.message||body?.message||`Media provider returned HTTP ${r.status}`);return body;}
function dataUrl(bytes:Buffer,type:string){return `data:${type};base64,${bytes.toString('base64')}`;}
async function download(url:string, signal?:AbortSignal){const u=new URL(url);if(u.protocol!=='https:'||/^(localhost|127\.|0\.|10\.|192\.168\.|169\.254\.|::1)/i.test(u.hostname))throw new Error('Rejected unsafe media result URL.');const r=await fetch(u,{redirect:'error',signal});if(!r.ok)throw new Error(`Media download failed (${r.status}).`);const bytes=Buffer.from(await r.arrayBuffer());return {bytes,mediaType:r.headers.get('content-type')?.split(';')[0]||'application/octet-stream'};}
function parameter(input:MediaJobInput,key:string, fallback?:any){return input.parameters?.[key] ?? fallback;}
export async function submitMediaJob(config:GlobalConfig,input:MediaJobInput,signal?:AbortSignal):Promise<SubmittedMedia>{
 const model=findMediaModel(config,input.providerId,input.modelId);const c=connection(config,input.providerId);const refs=await Promise.all((input.references??[]).map(r=>readAsset(r.assetId,input.projectId as any)));
 if(input.operation.endsWith('image')) return submitImage(c.base,c.key,model,input,refs,signal);
 return submitVideo(c.base,c.key,model,input,refs,signal);
}
async function submitImage(base:string,key:string,model:MediaModel,input:MediaJobInput,refs:Buffer[],signal?:AbortSignal):Promise<SubmittedMedia>{
 const body:any={model:input.modelId,prompt:input.prompt,n:parameter(input,'n',1)};const ratio=parameter(input,'aspectRatio');if(ratio)body.aspect_ratio=ratio;const size=parameter(input,'size');if(size)body.size=size;const quality=parameter(input,'quality');if(quality)body.quality=quality;
 if(refs.length) body.input_references=refs.map((b,i)=>({type:'image_url',image_url:{url:dataUrl(b,'image/png')},...(i===0?{}:{role:'reference_image'})}));
 if (refs.length && model.adapter === 'xai') {
   body.image = { type: 'image_url', url: dataUrl(refs[0], 'image/png') };
 }
 if (refs.length && model.adapter === 'openai') {
   const form = new FormData(); form.set('model', input.modelId); form.set('prompt', input.prompt); form.set('n', String(parameter(input, 'n', 1)));
   for (const bytes of refs) form.append('image[]', new Blob([new Uint8Array(bytes)], { type: 'image/png' }), 'reference.png');
   const response = await fetch(`${base}/images/edits`, { method: 'POST', headers: { authorization: `Bearer ${key}` }, body: form, signal });
   const text = await response.text(); let result: any; try { result = JSON.parse(text); } catch { result = { error: { message: text } }; }
   if (!response.ok) throw new Error(result?.error?.message || `Media provider returned HTTP ${response.status}`);
   const files = await Promise.all((result.data ?? []).map(async (x: any) => x.b64_json ? { bytes: Buffer.from(x.b64_json, 'base64'), mediaType: `image/${result.output_format || 'png'}`, filename: 'generated.png' } : x.url ? { ...(await download(x.url, signal)), filename: 'generated.png' } : null));
   return { status: 'succeeded', immediate: files.filter(Boolean) as any };
 }
 const endpoint=model.adapter==='openrouter'?`${base}/images`:`${base}/images/generations`;
 const result=await json(endpoint,{method:'POST',headers:headers(key),body:JSON.stringify(body)},signal);
 const files=await Promise.all((result.data??[]).map(async (x:any)=>x.b64_json?{bytes:Buffer.from(x.b64_json,'base64'),mediaType:`image/${result.output_format||'png'}`,filename:'generated.png'}:x.url?{...(await download(x.url,signal)),filename:'generated.png'}:null));
 return {status:'succeeded',immediate:files.filter(Boolean) as any};
}
async function submitVideo(base:string,key:string,model:MediaModel,input:MediaJobInput,refs:Buffer[],signal?:AbortSignal):Promise<SubmittedMedia>{
 const p=input.parameters??{};let url:string,body:any={model:input.modelId,prompt:input.prompt}; if(p.duration!==undefined)body.duration=p.duration;if(p.resolution)body.resolution=p.resolution;if(p.aspectRatio)body.aspect_ratio=p.aspectRatio;if(p.generateAudio!==undefined)body.generate_audio=p.generateAudio;
 if(refs.length) body.image_url=dataUrl(refs[0],'image/png');
 if(model.adapter==='xai'){url=`${base}/videos/generations`;const r=await json(url,{method:'POST',headers:headers(key),body:JSON.stringify(body)},signal);return {status:'running',upstreamId:r.request_id};}
 if(model.adapter==='minimax'){url=`${base}/v2/video_generation`;const content:any[]=[{type:'text',text:input.prompt}];for(const r of input.references??[])content.push({type:'image_url',image_url:{url:dataUrl(refs[input.references!.indexOf(r)],'image/png')},role:r.role==='reference'?'reference_image':r.role});body={model:input.modelId,content};if(p.duration!==undefined)body.duration=p.duration;if(p.resolution)body.resolution=p.resolution;const r=await json(url,{method:'POST',headers:headers(key),body:JSON.stringify(body)},signal);return {status:'running',upstreamId:r.task?.id||r.task_id};}
 if(model.adapter==='ark'){url=`${base}/contents/generations/tasks`;const r=await json(url,{method:'POST',headers:headers(key),body:JSON.stringify(body)},signal);return {status:'running',upstreamId:r.id||r.task_id};}
 url=`${base}/videos`;const r=await json(url,{method:'POST',headers:headers(key),body:JSON.stringify(body)},signal);return {status:'running',upstreamId:r.id||r.task_id};
}
export async function pollMediaJob(config:GlobalConfig,input:MediaJobInput,upstreamId:string,signal?:AbortSignal):Promise<PolledMedia>{const model=findMediaModel(config,input.providerId,input.modelId);const c=connection(config,input.providerId);let r:any;
 if(model.adapter==='xai')r=await json(`${c.base}/videos/${encodeURIComponent(upstreamId)}`,{headers:headers(c.key)},signal),r={status:r.status,url:r.video?.url};
 else if(model.adapter==='minimax') {r=await json(`${c.base}/v2/query/video_generation/${encodeURIComponent(upstreamId)}`,{headers:headers(c.key)},signal);r={status:r.task?.status,url:r.task?.content?.url};}
 else if(model.adapter==='ark'){r=await json(`${c.base}/contents/generations/tasks/${encodeURIComponent(upstreamId)}`,{headers:headers(c.key)},signal);r={status:r.status,url:r.content?.video_url||r.content?.url};}
 else {r=await json(`${c.base}/videos/${encodeURIComponent(upstreamId)}`,{headers:headers(c.key)},signal);r={status:r.status,url:r.video?.url||r.url};}
 if(['failed','expired','cancelled','canceled'].includes(String(r.status)))return {status:'failed',error:`Media provider task ${r.status}.`};if(['succeeded','completed','done'].includes(String(r.status))&&r.url){const d=await download(r.url,signal);return {status:'succeeded',...d};}return {status:'running'};
}
export async function cancelMediaJob(config:GlobalConfig,input:MediaJobInput,upstreamId:string,signal?:AbortSignal){const model=findMediaModel(config,input.providerId,input.modelId);const c=connection(config,input.providerId);if(model.adapter==='xai')return false;const url=model.adapter==='minimax'?`${c.base}/v2/video_generation/${encodeURIComponent(upstreamId)}`:model.adapter==='ark'?`${c.base}/contents/generations/tasks/${encodeURIComponent(upstreamId)}`:`${c.base}/videos/${encodeURIComponent(upstreamId)}`;const r=await fetch(url,{method:'DELETE',headers:headers(c.key),signal});return r.ok;}
