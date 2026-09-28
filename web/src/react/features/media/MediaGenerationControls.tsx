import { useEffect, useMemo, useState } from 'react';
import { Film, Image as ImageIcon, LoaderCircle, X } from 'lucide-react';
import { apiRequest } from '../../../lib/api/origin';
import type { MediaJob, MediaModel, MediaOperation } from '../../../lib/contracts/media-generation';
import type { MediaDraft } from './useMediaDraft';

type Mode = 'chat' | 'image' | 'video';
export function MediaGenerationControls({ mode, onModeChange, models, selected, onSelected, operation, parameters, onParameters, job, onCancel, media }: { mode: Mode; onModeChange:(mode:Mode)=>void; models:MediaModel[]; selected:MediaModel|undefined; onSelected:(model:MediaModel)=>void; operation:MediaOperation|undefined; parameters:Record<string,string|number|boolean>; onParameters:(p:Record<string,string|number|boolean>)=>void; job:MediaJob|undefined; onCancel:()=>void; media:MediaDraft|undefined }) {
 const images=media?.parts.filter(p=>p.type==='image').length ?? 0;
 return <div className="flex flex-wrap items-center gap-1.5" data-media-generation-controls="true">
  <button type="button" aria-pressed={mode==='chat'} onClick={()=>onModeChange('chat')} className="agent-dock-composer-chip rounded-full px-2 text-[11px]">对话</button>
  <button type="button" aria-pressed={mode==='image'} onClick={()=>onModeChange('image')} className="agent-dock-composer-chip inline-flex items-center gap-1 rounded-full px-2 text-[11px]"><ImageIcon size={12}/>图片</button>
  <button type="button" aria-pressed={mode==='video'} onClick={()=>onModeChange('video')} className="agent-dock-composer-chip inline-flex items-center gap-1 rounded-full px-2 text-[11px]"><Film size={12}/>视频</button>
  {mode!=='chat' && <select aria-label="媒体模型 / Media model" value={selected ? `${selected.providerId}:${selected.modelId}` : ''} onChange={e=>{const [providerId,...rest]=e.target.value.split(':');const modelId=rest.join(':');const m=models.find(x=>x.providerId===providerId&&x.modelId===modelId);if(m)onSelected(m)}} className="h-7 max-w-60 rounded-full border border-border/40 bg-background px-2 text-[11px]">{models.map(m=><option key={`${m.providerId}:${m.modelId}`} value={`${m.providerId}:${m.modelId}`}>{m.providerLabel} · {m.label}</option>)}</select>}
  {mode==='image' && <select aria-label="图片质量 / Image quality" value={String(parameters.quality??'auto')} onChange={e=>onParameters({...parameters,quality:e.target.value})} className="h-7 rounded-full border border-border/40 bg-background px-2 text-[11px]"><option value="auto">自动质量</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select>}
  {mode==='video' && <><select aria-label="视频时长 / Video duration" value={String(parameters.duration??6)} onChange={e=>onParameters({...parameters,duration:Number(e.target.value)})} className="h-7 rounded-full border border-border/40 bg-background px-2 text-[11px]"><option value="4">4 秒</option><option value="6">6 秒</option><option value="8">8 秒</option><option value="10">10 秒</option><option value="15">15 秒</option></select><select aria-label="视频分辨率 / Video resolution" value={String(parameters.resolution??'720p')} onChange={e=>onParameters({...parameters,resolution:e.target.value})} className="h-7 rounded-full border border-border/40 bg-background px-2 text-[11px]"><option value="480p">480p</option><option value="720p">720p</option><option value="1080p">1080p</option><option value="2K">2K</option></select></>}
  {mode!=='chat' && images>0 && <span className="text-[10px] text-muted-foreground">{operation==='image-to-image'?'图生图':'图生视频'}</span>}
  {job && job.status!=='succeeded' && <span className="inline-flex items-center gap-1 text-[10px] text-muted-foreground"><LoaderCircle size={12} className="animate-spin"/>{job.status}<button type="button" onClick={onCancel} aria-label="取消媒体任务"><X size={12}/></button></span>}
 </div>;
}
export function useMediaGenerationModels(mode:Mode) {
 const [models,setModels]=useState<MediaModel[]>([]);const [selectedKey,setSelectedKey]=useState('');
 useEffect(()=>{const controller=new AbortController();void apiRequest<{models:MediaModel[]}>('/api/agent-runtime/media/models',{signal:controller.signal,silent:true}).then(r=>setModels(r.models)).catch(()=>{});return()=>controller.abort()},[]);
 const filtered=useMemo(()=>models.filter(m=>mode==='image'?m.capabilities.operations.some(x=>x.endsWith('image')):mode==='video'?m.capabilities.operations.some(x=>x.endsWith('video')):false),[models,mode]);
 const selected=filtered.find(m=>`${m.providerId}:${m.modelId}`===selectedKey)??filtered[0];
 useEffect(()=>{setSelectedKey('')},[mode]);
 useEffect(()=>{if(selected&&!selectedKey)setSelectedKey(`${selected.providerId}:${selected.modelId}`)},[selected,selectedKey]);
 return {models:filtered,selected,onSelected:(m:MediaModel)=>setSelectedKey(`${m.providerId}:${m.modelId}`)};
}
