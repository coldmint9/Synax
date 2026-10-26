import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ToolExecutionInput } from '../contracts.js';

const mocks = vi.hoisted(() => ({
  sessions: new Map<string, any>(), snapshot: {} as any,
  service: { get: vi.fn(), workerSnapshot: vi.fn(), setWorkerExecution: vi.fn(), workerAction: vi.fn(), workerSaveFile: vi.fn(), file: vi.fn(), awaitWorkerAdmission: vi.fn(), cancelWorkerMr: vi.fn(), gitMr: { files: vi.fn() }, store: { exclusive: vi.fn() } },
  coordinator: { submitAsync: vi.fn(), waitForSessionIdle: vi.fn(), reconcileFencedSession: vi.fn() },
  create: vi.fn(), flush: vi.fn(), wait: vi.fn(), recover: vi.fn(), acknowledge: vi.fn(),
}));
vi.mock('./service.js', () => ({ conversationGitService: mocks.service }));
vi.mock('../session-store.js', () => ({ agentRuntimeStore: {
  tryGetSession: (id: string) => mocks.sessions.get(id), getSession: (id: string) => mocks.sessions.get(id),
  hydrateSessionSummary: vi.fn(), flushSession: mocks.flush,
  updateSessionMetadata: (id: string, patch: any) => Object.assign(mocks.sessions.get(id).sessionMetadata, patch),
  updateSession: (id: string, patch: any) => Object.assign(mocks.sessions.get(id), patch),
} }));
vi.mock('../session-runtime.js', () => ({ agentSessionRuntime: { create: mocks.create } }));
vi.mock('../run-coordinator.js', () => ({ runCoordinator: mocks.coordinator }));
vi.mock('../profile-service.js', () => ({ profileService: { register: vi.fn() } }));
vi.mock('../tool-registry.js', () => ({ toolRegistry: { registerProvider: vi.fn() } }));
vi.mock('../session-recovery.js', () => ({ ensureSessionRecovered: vi.fn() }));
vi.mock('../../../infrastructure/runtime/execution-context.js', () => ({ outsideExecutionContext: (fn: () => unknown) => fn() }));
vi.mock('../subagent-control-broker.js', () => ({ subagentCompletionBroker: { wait: mocks.wait, recover: mocks.recover, acknowledge: mocks.acknowledge } }));
vi.mock('./worker-watchdog.js', () => ({ MERGE_WORKER_PROGRESS_TIMEOUT_MS: 600_000, mergeWorkerWatchdog: {
  progress: vi.fn(), watch: () => ({ dispose() {}, timedOut: false, expired: new Promise(() => {}) }),
} }));
import { conversationMergeWorkerTools, resumeConversationMergeWorker, startConversationMergeWorker, waitForConversationMergeWorker, hasLocalConversationMergeWorker } from './worker.js';

let serial = 0;
let objectId: string;
let release: (() => void) | undefined;
const call = (toolId: string, args: unknown = {}, toolCallId = toolId) => conversationMergeWorkerTools.find(tool => tool.id === toolId)!.execute({
  sessionId: 'child', toolId, toolCallId, args,
} as ToolExecutionInput);

beforeEach(() => {
  vi.resetAllMocks(); mocks.sessions.clear(); objectId = `task-${++serial}`; release = undefined;
  mocks.sessions.set('parent', { id: 'parent', projectId: 'project', status: 'running', sessionMetadata: {} });
  mocks.sessions.set('child', { id: 'child', projectId: 'project', parentSessionId: 'parent', profileId: 'git-merge-worker', status: 'completed', sessionMetadata: {
    mergeWorker: { parentSessionId: 'parent', projectId: 'project', objectId, epoch: 1 },
  } });
  mocks.snapshot = { task: { id: objectId, projectId: 'project', revision: 3 }, mr: { id: 'mr', title: 'Merge', status: 'conflicted', version: 4, checkResults: [], checks: [] }, files: [],
    execution: { childSessionId: 'child', epoch: 1, revision: 2, status: 'waiting_user', phase: 'resolving', joinMode: 'blocking' } };
  mocks.service.get.mockImplementation(async () => structuredClone(mocks.snapshot));
  mocks.service.workerSnapshot.mockImplementation(async () => structuredClone(mocks.snapshot));
  mocks.service.setWorkerExecution.mockImplementation(async (_parent, _id, patch) => {
    mocks.snapshot.execution = { ...mocks.snapshot.execution, ...patch, revision: mocks.snapshot.execution.revision + 1 };
    return mocks.snapshot.execution;
  });
  mocks.service.store.exclusive.mockImplementation(async (_key, action) => action());
  mocks.service.workerAction.mockImplementation(async () => structuredClone(mocks.snapshot));
  mocks.service.workerSaveFile.mockImplementation(async () => structuredClone(mocks.snapshot));
  mocks.coordinator.submitAsync.mockImplementation(async () => {
    await new Promise<void>(resolve => { release = resolve; });
  });
});
afterEach(async () => {
  release?.();
  await vi.waitFor(() => expect(hasLocalConversationMergeWorker(objectId)).toBe(false));
});

it('coalesces concurrent re-entry into one new epoch and preserves the task and child', async () => {
  const [first, second] = await Promise.all([
    resumeConversationMergeWorker('parent', objectId, 'Accept source deletions.'),
    resumeConversationMergeWorker('parent', objectId, 'Accept source deletions.'),
  ]);
  expect(first).toEqual(second);
  expect(first.execution).toMatchObject({ childSessionId: 'child', epoch: 2, status: 'running' });
  expect(mocks.create).not.toHaveBeenCalled();
  expect(mocks.coordinator.submitAsync).toHaveBeenCalledExactlyOnceWith('child', { message: expect.stringContaining('Accept source deletions.') }, `merge-worker-resume:${objectId}:2`, 'continue');
  expect(mocks.flush).toHaveBeenCalledWith('child');
  const joined = await resumeConversationMergeWorker('parent', objectId);
  expect(joined.execution?.epoch).toBe(2);
  expect(mocks.coordinator.submitAsync).toHaveBeenCalledTimes(1);
});

it('starts an existing failed worker by re-entering the same child', async () => {
  mocks.snapshot.execution.status = 'recovery_required';
  const resumed = await startConversationMergeWorker('parent', objectId);
  expect(resumed.execution).toMatchObject({ status: 'running', epoch: 2, childSessionId: 'child' });
  expect(mocks.create).not.toHaveBeenCalled();
});

it.each(['paused', 'waiting_user', 'cancelled', 'completed'])('keeps %s unchanged on implicit start', async status => {
  mocks.snapshot.execution.status = status;
  await startConversationMergeWorker('parent', objectId);
  expect(mocks.coordinator.submitAsync).not.toHaveBeenCalled();
});

it('does not reopen a failed user stop and rejects a stopped parent', async () => {
  Object.assign(mocks.snapshot.execution, { status: 'recovery_required', stopRequested: 'pause' });
  await startConversationMergeWorker('parent', objectId);
  expect(mocks.coordinator.submitAsync).not.toHaveBeenCalled();
  mocks.sessions.get('parent').sessionMetadata.manualStop = true;
  await expect(resumeConversationMergeWorker('parent', objectId)).rejects.toMatchObject({ code: 'PARENT_STOPPED' });
});

it('returns a stopped task without waiting again on its consumed mailbox', async () => {
  expect(await waitForConversationMergeWorker('parent', mocks.snapshot)).toBe(mocks.snapshot);
  expect(mocks.wait).not.toHaveBeenCalled();
});

it('waits for a failed child to publish durable settlement before returning to the parent', async () => {
  const running = await resumeConversationMergeWorker('parent', objectId);
  mocks.wait.mockResolvedValue({ reason: 'recovery_required' });
  const waiting = waitForConversationMergeWorker('parent', running);
  mocks.sessions.get('child').status = 'failed';
  mocks.snapshot.mr.status = 'ready';
  await vi.waitFor(() => expect(mocks.wait).toHaveBeenCalledTimes(1));
  release?.();
  expect((await waiting).execution?.status).toBe('failed');
});

it('retries cancellation cleanup instead of restarting a failed cancellation', async () => {
  Object.assign(mocks.snapshot.execution, { status: 'recovery_required', stopRequested: 'cancel', childSessionId: undefined });
  await resumeConversationMergeWorker('parent', objectId);
  expect(mocks.service.cancelWorkerMr).toHaveBeenCalledWith('parent', objectId);
  expect(mocks.coordinator.submitAsync).not.toHaveBeenCalled();
});

it('allows stopped inspections but fences recovery writes until parent re-entry', async () => {
  expect((await call('git.merge.worker.inspect')).result).toMatchObject({ execution: { status: 'waiting_user' } });
  await expect(call('git.merge.worker.recover')).rejects.toMatchObject({ code: 'WORKER_STALE' });
  expect(mocks.service.workerAction).not.toHaveBeenCalled();
  mocks.sessions.get('child').sessionMetadata.mergeWorker.epoch = 0;
  await expect(call('git.merge.worker.inspect')).rejects.toMatchObject({ code: 'WORKER_STALE' });
});

it('accepts whole-file deletion choices and rejects ambiguous resolutions', async () => {
  mocks.snapshot.execution.status = 'running';
  await call('git.merge.worker.resolve', { fileId: 'file', expectedRevision: 'rev', choice: 'source' });
  expect(mocks.service.workerSaveFile).toHaveBeenCalledWith('child', objectId, 'file', expect.objectContaining({ choice: 'source', content: undefined, resolve: true, expectedRevision: 'rev' }));
  await expect(call('git.merge.worker.resolve', { fileId: 'file', expectedRevision: 'rev', content: '', choice: 'delete' })).rejects.toThrow();
});

it('serializes concurrent writes so each reads the latest task and MR versions', async () => {
  mocks.snapshot.execution.status = 'running';
  let finishFirst!: () => void;
  mocks.service.workerAction.mockImplementationOnce(async () => {
    await new Promise<void>(resolve => { finishFirst = resolve; });
    mocks.snapshot.mr.version++; mocks.snapshot.task.revision++;
    return structuredClone(mocks.snapshot);
  });
  const first = call('git.merge.worker.recover', {}, 'one');
  const second = call('git.merge.worker.prepare', {}, 'two');
  await vi.waitFor(() => expect(mocks.service.workerAction).toHaveBeenCalledTimes(1));
  finishFirst(); await Promise.all([first, second]);
  expect(mocks.service.workerAction.mock.calls[1][2]).toMatchObject({ expectedVersion: 5, expectedTaskRevision: 4 });
});

it('returns a completed finalize without applying the candidate again', async () => {
  mocks.snapshot.execution.status = 'completed'; mocks.snapshot.mr.status = 'merged';
  expect((await call('git.merge.worker.finalize')).result).toMatchObject({ mr: { status: 'merged' } });
  expect(mocks.service.workerAction).not.toHaveBeenCalled();
});
