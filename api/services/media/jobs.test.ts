import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getRawSqlite } from '../../db/index.js';
import { agentSessionRuntime } from '../agent-runtime/session-runtime.js';
import { createAsset, sessionHasAsset } from '../agent-runtime/media-assets.js';
import { executorInput, resetAgentRuntimeFixtures } from '../agent-runtime/__tests__/agent-runtime-fixtures.js';
import { createMediaJob, cancelJob, getMediaJob, listMediaJobs, recoverMediaJobs } from './jobs.js';

const adapter = vi.hoisted(() => ({
  submit: vi.fn(),
  poll: vi.fn(),
  cancel: vi.fn(async () => undefined),
}));
vi.mock('./adapters.js', () => ({
  submitMediaJob: adapter.submit,
  pollMediaJob: adapter.poll,
  cancelMediaJob: adapter.cancel,
}));
vi.mock('./catalog.js', () => ({
  findMediaModel: () => ({
    capabilities: {
      operations: ['text-to-image', 'image-to-image', 'text-to-video', 'image-to-video'],
      referenceRoles: ['reference', 'first_frame', 'last_frame'],
      maxReferences: 2,
    },
  }),
}));

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==', 'base64');
const selection = {
  providerId: 'custom-api:studio', modelId: 'image-model',
  operation: 'image-to-image', prompt: 'A city',
} as const;

beforeEach(() => {
  resetAgentRuntimeFixtures();
  getRawSqlite().prepare('DELETE FROM media_jobs').run();
  adapter.submit.mockReset();
  adapter.poll.mockReset();
  adapter.cancel.mockClear();
});

describe('media jobs', () => {
  it('binds project-owned references to the session, writes results and deduplicates submission', async () => {
    const session = agentSessionRuntime.create(executorInput);
    const asset = await createAsset(session.projectId, 'reference.png', png, 'image/png');
    adapter.submit.mockResolvedValue({ status: 'succeeded', immediate: [{ bytes: png, filename: 'result.png', mediaType: 'image/png' }] });
    const input = { ...selection, references: [{ assetId: asset.id, role: 'reference' }], idempotencyKey: 'same' };
    const first = createMediaJob(session.id, session.projectId, input);
    expect(sessionHasAsset(session.id, asset.id)).toBe(true);
    expect(createMediaJob(session.id, session.projectId, input).id).toBe(first.id);
    await vi.waitFor(() => expect(getMediaJob(first.id)?.status).toBe('succeeded'));
    expect(adapter.submit).toHaveBeenCalledTimes(1);
    expect(listMediaJobs(session.id)[0].resultAssetIds).toHaveLength(1);
  });

  it('rejects assets from another project without binding them', async () => {
    const session = agentSessionRuntime.create(executorInput);
    const foreign = await createAsset('other-project', 'reference.png', png, 'image/png');
    expect(() => createMediaJob(session.id, session.projectId, {
      ...selection, references: [{ assetId: foreign.id, role: 'reference' }], idempotencyKey: 'foreign',
    })).toThrow(/different project/);
    expect(sessionHasAsset(session.id, foreign.id)).toBe(false);
  });

  it('keeps a cancelled submission cancelled even when its provider responds later', async () => {
    const session = agentSessionRuntime.create(executorInput);
    let finish!: (value: unknown) => void;
    adapter.submit.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
    const job = createMediaJob(session.id, session.projectId, {
      ...selection, operation: 'text-to-image', references: [], idempotencyKey: 'cancel',
    });
    await vi.waitFor(() => expect(getMediaJob(job.id)?.status).toBe('submitting'));
    expect((await cancelJob(job.id))?.status).toBe('cancelled');
    finish({ status: 'succeeded', immediate: [{ bytes: png, filename: 'late.png', mediaType: 'image/png' }] });
    await vi.waitFor(() => expect(adapter.submit).toHaveBeenCalledTimes(1));
    expect(getMediaJob(job.id)?.status).toBe('cancelled');
    expect(getMediaJob(job.id)?.resultAssetIds).toEqual([]);
  });

  it('resumes polling an existing upstream task without submitting it again', async () => {
    const session = agentSessionRuntime.create(executorInput);
    const now = new Date().toISOString();
    const input = { ...selection, operation: 'text-to-video', references: [], idempotencyKey: 'recover', projectId: session.projectId };
    getRawSqlite().prepare('INSERT INTO media_jobs (id,session_id,project_id,provider_id,model_id,operation,input_json,idempotency_key,status,upstream_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('mjob_recover', session.id, session.projectId, input.providerId, input.modelId, input.operation, JSON.stringify(input), input.idempotencyKey, 'running', 'upstream-1', now, now);
    adapter.poll.mockResolvedValue({ status: 'failed', error: 'upstream failed' });
    expect(recoverMediaJobs()).toBe(1);
    await vi.waitFor(() => expect(getMediaJob('mjob_recover')?.status).toBe('failed'), { timeout: 5000 });
    expect(adapter.submit).not.toHaveBeenCalled();
    expect(adapter.poll).toHaveBeenCalledTimes(1);
  });
});
