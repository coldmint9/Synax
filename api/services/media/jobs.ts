import { randomUUID } from 'node:crypto';
import { getRawSqlite } from '../../db/index.js';
import { getGlobalConfigForRuntime } from '../../lib/config/config-store.js';
import { bindAssets, createAsset, deleteUnboundAsset, getAsset } from '../agent-runtime/media-assets.js';
import { assertSessionMediaBudget } from '../agent-runtime/tools/media-context.js';
import { modalityForMime } from '../agent-runtime/content-parts.js';
import { agentRuntimeStore } from '../agent-runtime/session-store.js';
import { sessionLiveBus } from '../agent-runtime/session-live-bus.js';
import type { MediaJob, MediaJobInput } from './contracts.js';
import { mediaJobInputSchema } from './schema.js';
import { findMediaModel } from './catalog.js';
import { cancelMediaJob, pollMediaJob, submitMediaJob } from './adapters.js';

const MAX_VIDEO_OUTPUT = 500 * 1024 * 1024;
const rowToJob = (r:any):MediaJob=>({id:r.id,sessionId:r.session_id,input:JSON.parse(r.input_json),status:r.status,upstreamId:r.upstream_id||undefined,resultAssetIds:JSON.parse(r.result_asset_ids_json||'[]'),errorCode:r.error_code||undefined,error:r.error||undefined,createdAt:r.created_at,updatedAt:r.updated_at,cancellationSupported:true});
function row(id:string){return getRawSqlite().prepare('SELECT * FROM media_jobs WHERE id=?').get(id) as any;}
export function getMediaJob(id:string){const r=row(id);return r?rowToJob(r):undefined;}
export function listMediaJobs(sessionId:string,limit=50){return (getRawSqlite().prepare('SELECT * FROM media_jobs WHERE session_id=? ORDER BY created_at DESC LIMIT ?').all(sessionId,limit) as any[]).map(rowToJob);}
function update(id:string,patch:Record<string,any>){const keys=Object.keys(patch);if(!keys.length)return;const values=keys.map(k=>patch[k]);getRawSqlite().prepare(`UPDATE media_jobs SET ${keys.map(k=>`${k}=?`).join(',')}, updated_at=? WHERE id=?`).run(...values,new Date().toISOString(),id);}
function updateActive(id: string, patch: Record<string, unknown>): boolean {
  const keys = Object.keys(patch);
  const result = getRawSqlite().prepare(
    `UPDATE media_jobs SET ${keys.map((key) => `${key}=?`).join(',')}, updated_at=? WHERE id=? AND status NOT IN ('succeeded','failed','cancelled','unknown')`,
  ).run(...keys.map((key) => patch[key]), new Date().toISOString(), id);
  return result.changes > 0;
}
export function createMediaJob(sessionId:string,projectId:string,raw:unknown){const input=mediaJobInputSchema.parse(raw) as MediaJobInput;input.projectId=projectId;const existing=getRawSqlite().prepare('SELECT * FROM media_jobs WHERE session_id=? AND idempotency_key=?').get(sessionId,input.idempotencyKey) as any;if(existing)return rowToJob(existing);const model=findMediaModel(getGlobalConfigForRuntime(), input.providerId, input.modelId);if(!model.capabilities.operations.includes(input.operation)) throw new Error(`Model '${input.modelId}' does not support ${input.operation}.`);if(input.references!.length> (model.capabilities.maxReferences ?? 16))throw new Error('Too many media references for this model.');if(input.operation.startsWith('image-to') && !input.references!.length) throw new Error('An image reference is required for image-to-media generation.');if(input.references!.length){for(const ref of input.references!) {const asset=getAsset(ref.assetId,projectId);if(!asset.mediaType.startsWith('image/'))throw new Error('Generation references must be images.');if(model.capabilities.referenceRoles && !model.capabilities.referenceRoles.includes(ref.role))throw new Error(`Reference role '${ref.role}' is not supported by this model.`);}bindAssets(sessionId,input.references!.map((ref)=>({type:'image' as const,assetId:ref.assetId})));assertSessionMediaBudget(sessionId,input.references!.map(r=>r.assetId));}const now=new Date().toISOString();const id=`mjob_${randomUUID().replaceAll('-','')}`;getRawSqlite().prepare('INSERT INTO media_jobs (id,session_id,project_id,provider_id,model_id,operation,input_json,idempotency_key,status,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id,sessionId,projectId,input.providerId,input.modelId,input.operation,JSON.stringify(input),input.idempotencyKey,'queued',now,now);agentRuntimeStore.appendMessage({id:`media-input-${id}`,sessionId,runId:null,stepId:null,role:'user',content:input.prompt,contentParts:input.references!.map((ref)=>({type:'image' as const,assetId:ref.assetId})),metadata:{mediaJobId:id},createdAt:now});void executeMediaJob(id);return getMediaJob(id)!;}
async function executeMediaJob(id: string) {
  const job = row(id);
  if (!job || ['succeeded', 'failed', 'cancelled', 'unknown'].includes(job.status)) return;
  if (job.upstream_id) {
    await pollLoop(id);
    return;
  }
  const input = JSON.parse(job.input_json) as MediaJobInput;
  const config = getGlobalConfigForRuntime();
  try {
    if (!updateActive(id, { status: 'submitting', lease_until: Date.now() + 120_000 })) return;
    const submitted = await submitMediaJob(config, input);
    if (row(id)?.status === 'cancelled') {
      if (submitted.upstreamId) await cancelMediaJob(config, input, submitted.upstreamId).catch(() => {});
      return;
    }
    if (submitted.immediate?.length) {
      const assets: string[] = [];
      for (const file of submitted.immediate) {
        const asset = await createAsset(job.project_id, file.filename, file.bytes, file.mediaType);
        assets.push(asset.id);
      }
      if (!updateActive(id, { status: 'succeeded', result_asset_ids_json: JSON.stringify(assets), lease_until: 0 })) {
        await Promise.all(assets.map((assetId) => deleteUnboundAsset(assetId).catch(() => {})));
        return;
      }
      publish(job, assets);
      return;
    }
    if (updateActive(id, { status: submitted.status, upstream_id: submitted.upstreamId ?? null, lease_until: 0 }) && submitted.upstreamId) {
      void pollLoop(id);
    }
  } catch (error) {
    if (updateActive(id, { status: 'failed', error: String(error instanceof Error ? error.message : error), error_code: 'MEDIA_PROVIDER_ERROR', lease_until: 0 })) {
      publish(job, []);
    }
  }
}
async function pollLoop(id: string) {
  for (let attempt = 0; attempt < 120; attempt++) {
    const job = row(id);
    if (!job || ['succeeded', 'failed', 'cancelled', 'unknown'].includes(job.status)) return;
    await new Promise((resolve) => setTimeout(resolve, Math.min(30_000, 2000 + attempt * 500)));
    if (row(id)?.status === 'cancelled') return;
    try {
      const result = await pollMediaJob(getGlobalConfigForRuntime(), JSON.parse(job.input_json), job.upstream_id);
      if (row(id)?.status === 'cancelled') return;
      if (result.status === 'running') continue;
      if (result.status === 'failed') {
        if (updateActive(id, { status: 'failed', error: result.error ?? 'Media provider task failed.', error_code: 'MEDIA_TASK_FAILED' })) publish(job, []);
        return;
      }
      if (result.bytes) {
        if (result.bytes.length > MAX_VIDEO_OUTPUT) throw new Error('Generated video exceeds 500 MiB.');
        const asset = await createAsset(job.project_id, `generated-${id}.mp4`, result.bytes, result.mediaType ?? 'video/mp4');
        if (!updateActive(id, { status: 'succeeded', result_asset_ids_json: JSON.stringify([asset.id]), lease_until: 0 })) {
          await deleteUnboundAsset(asset.id).catch(() => {});
          return;
        }
        publish(job, [asset.id]);
        return;
      }
    } catch (error) {
      if (updateActive(id, { status: 'failed', error: String(error instanceof Error ? error.message : error), error_code: 'MEDIA_POLL_FAILED' })) publish(job, []);
      return;
    }
  }
  const job = row(id);
  if (job && updateActive(id, { status: 'unknown', error: 'Provider task polling window expired.', error_code: 'MEDIA_TASK_EXPIRED' })) publish(job, []);
}
function publish(r:any,assetIds:string[]){try{if(assetIds.length){const parts=assetIds.map(id=>({type:modalityForMime(getAsset(id,r.project_id).mediaType),assetId:id}));agentRuntimeStore.appendMessage({id:`media-${r.id}`,sessionId:r.session_id,runId:null,stepId:null,role:'assistant',content:'',contentParts:parts,metadata:{mediaJobId:r.id},createdAt:new Date().toISOString()});}sessionLiveBus.emit(r.session_id,{type:'media_job',jobId:r.id,status:assetIds.length?'succeeded':row(r.id)?.status,resultAssetIds:assetIds});}catch{}}
export async function cancelJob(id: string) {
  const job = row(id);
  if (!job) return undefined;
  if (!updateActive(id, { status: 'cancelled', error: 'Cancelled by user.', error_code: 'MEDIA_CANCELLED', lease_until: 0 })) return getMediaJob(id);
  publish(job, []);
  if (job.upstream_id) await cancelMediaJob(getGlobalConfigForRuntime(), JSON.parse(job.input_json), job.upstream_id).catch(() => {});
  return getMediaJob(id);
}
export function recoverMediaJobs() {
  const jobs = getRawSqlite().prepare("SELECT id FROM media_jobs WHERE status IN ('queued','submitting','running','downloading')").all() as Array<{ id: string }>;
  for (const job of jobs) void executeMediaJob(job.id);
  return jobs.length;
}
