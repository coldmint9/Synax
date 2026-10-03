import { z } from 'zod/v4';
import type { RegisteredTool } from '../contracts.js';
import { getGlobalConfigForRuntime } from '../../../infrastructure/runtime/config/config-store.js';
import { mediaModels } from '../../media/catalog.js';
import { cancelJob, getMediaJob, listMediaJobs } from '../../media/jobs.js';
import { agentRuntimeStore } from '../session-store.js';

export const mediaJobsTools: RegisteredTool[] = [
 { id:'media.models', label:'List media models', description:'List configured image and video models and their explicit generation capabilities.',
  progressiveDetails: "Use before image/video generation to discover configured provider/model IDs and supported controls; this catalog does not list speech/transcription models.", category:'read', mutability:'read', resumeBehavior:'auto', internalGate:'none', inputSchema:z.object({}), async execute(input){ return { result:{models:mediaModels(getGlobalConfigForRuntime())}, displaySummary:'Listed media models', artifacts:[] }; } },
 { id:'media.status', label:'Get media job status', description:'Get the status of a background image or video generation job.',
  progressiveDetails: "Use a jobId returned for this session, or discover IDs with media.list. Foreign or missing jobs are rejected.", category:'read', mutability:'read', resumeBehavior:'auto', internalGate:'none', inputSchema:z.object({jobId:z.string().min(1)}), async execute(input){ const job=getMediaJob(String((input.args as any).jobId)); if(!job||job.sessionId!==input.sessionId) throw new Error('Media job not found.'); return {result:{job},displaySummary:`Media job ${job.status}`,artifacts:[]}; } },
 { id:'media.cancel', label:'Cancel media job', description:'Cancel an in-flight media job without resubmitting it.',
  progressiveDetails: "Use a jobId from this session; foreign or missing jobs are rejected. Inspect media.status before deciding whether to cancel.", category:'task', mutability:'task', resumeBehavior:'none', internalGate:'network', inputSchema:z.object({jobId:z.string().min(1)}), async execute(input){ const job=getMediaJob(String((input.args as any).jobId)); if(!job||job.sessionId!==input.sessionId) throw new Error('Media job not found.'); return {result:{job:await cancelJob(job.id)},displaySummary:'Cancelled media job',artifacts:[]}; } },
 { id:'media.list', label:'List media jobs', description:'List recent image and video generation jobs in this session.',
  progressiveDetails: "Only returns jobs owned by this session; limit is 1-100.", category:'read', mutability:'read', resumeBehavior:'auto', internalGate:'none', inputSchema:z.object({limit:z.number().int().min(1).max(100).optional()}), async execute(input){ return {result:{jobs:listMediaJobs(input.sessionId,(input.args as any).limit)},displaySummary:'Listed media jobs',artifacts:[]}; } },
];
