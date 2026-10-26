import { createHash } from 'node:crypto';
import * as z from 'zod/v4';
import type { AgentProfile, RegisteredTool, SessionToolProvider, ToolExecutionInput, ToolExecutionResult } from '../contracts.js';
import { agentRuntimeStore } from '../session-store.js';
import { agentSessionRuntime } from '../session-runtime.js';
import { profileService } from '../profile-service.js';
import { runCoordinator } from '../run-coordinator.js';
import { toolRegistry } from '../tool-registry.js';
import { subagentCompletionBroker } from '../subagent-control-broker.js';
import { outsideExecutionContext } from '../../../infrastructure/runtime/execution-context.js';
import { ensureSessionRecovered } from '../session-recovery.js';
import { conversationGitService } from './service.js';
import type { ConversationGitActionName, ConversationGitSnapshot } from './contracts.js';
import { GitMrError } from '../../git-mr/errors.js';
import { mergeWorkerWatchdog, MERGE_WORKER_PROGRESS_TIMEOUT_MS } from './worker-watchdog.js';
import { withDeadline } from '../managed-process.js';

export const CONVERSATION_MERGE_WORKER_PROFILE_ID = 'git-merge-worker';
export const CONVERSATION_MERGE_WORKER_PROVIDER_ID = 'conversation-git-worker';
const bindingKey = 'mergeWorker';
const workerTools = [
  'git.merge.worker.inspect', 'git.merge.worker.prepare', 'git.merge.worker.files',
  'git.merge.worker.read', 'git.merge.worker.resolve', 'git.merge.worker.continue',
  'git.merge.worker.checks', 'git.merge.worker.finalize', 'git.merge.worker.waiting', 'git.merge.worker.report', 'git.merge.worker.recover',
] as const;
type WorkerBinding = { parentSessionId: string; objectId: string; projectId: string; epoch: number; supervisorPid?: number };
type WorkerState = { childSessionId: string; promise: Promise<void>; epoch: number };
const activeWorkers = new Map<string, WorkerState>();
const launches = new Map<string, Promise<ConversationGitSnapshot>>();
export function hasLocalConversationMergeWorker(objectId: string): boolean {
  return activeWorkers.has(objectId) || launches.has(objectId);
}

function result(value: unknown, displaySummary: string): ToolExecutionResult { return { result: value, displaySummary, artifacts: [] }; }
function compact(snapshot: ConversationGitSnapshot) {
  return { objectId: snapshot.task.id, taskRevision: snapshot.task.revision, execution: snapshot.execution,
    mr: { id: snapshot.mr.id, status: snapshot.mr.status, version: snapshot.mr.version, target: snapshot.mr.target,
      targetOid: snapshot.mr.targetOid, steps: snapshot.mr.steps, candidateOid: snapshot.mr.candidateOid,
      candidateTree: snapshot.mr.candidateTree, checks: snapshot.mr.checks,
      checkResults: snapshot.mr.checkResults.map(item => ({ ...item, output: item.output.slice(-8_000) })), error: snapshot.mr.error },
    stale: snapshot.stale, staleReason: snapshot.staleReason, files: snapshot.files };
}
function bindingFor(sessionId: string): WorkerBinding {
  const child = agentRuntimeStore.tryGetSession(sessionId);
  if (!child || child.profileId !== CONVERSATION_MERGE_WORKER_PROFILE_ID || !child.parentSessionId)
    throw new GitMrError('A dedicated merge worker session is required.', 'WORKER_AUTHORITY', 403);
  const binding = child.sessionMetadata?.[bindingKey] as WorkerBinding | undefined;
  if (!binding || binding.parentSessionId !== child.parentSessionId || binding.projectId !== child.projectId || !binding.objectId)
    throw new GitMrError('The merge worker binding is invalid.', 'WORKER_AUTHORITY', 403);
  return binding;
}
function argsOf(input: ToolExecutionInput) { return input.args && typeof input.args === 'object' ? input.args as Record<string, unknown> : {}; }
const requestId = (input: ToolExecutionInput) => `worker_${createHash('sha256').update(input.toolCallId).digest('hex')}`;
const empty = z.object({}).strict();
const fileInput = z.object({ fileId: z.string().min(1).max(200) }).strict();
const readInput = fileInput.extend({ side: z.enum(['base', 'target', 'source', 'result']).default('result'), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(48_000).default(24_000), byteOffset: z.number().int().min(0).optional(), expectedRevision: z.string().min(1).max(256).optional() }).strict().refine(value => value.byteOffset === undefined || Boolean(value.expectedRevision), 'Byte paging requires the current expectedRevision.');
const resolveInput = fileInput.extend({ expectedRevision: z.string().min(1).max(256), content: z.string().max(2 * 1024 * 1024), rationale: z.string().max(16_000).optional() }).strict();
async function workerSnapshot(input: ToolExecutionInput) {
  const binding = bindingFor(input.sessionId);
  const snapshot = await conversationGitService.workerSnapshot(binding.parentSessionId, binding.objectId);
  if (snapshot.execution?.epoch !== binding.epoch || snapshot.execution.childSessionId !== input.sessionId || !['queued', 'running'].includes(snapshot.execution.status)) throw new GitMrError('This merge worker is stale or stopped.', 'WORKER_STALE', 409);
  return { binding, snapshot };
}
async function workerAction(input: ToolExecutionInput, action: ConversationGitActionName, skipChecks = false) {
  const { binding, snapshot } = await workerSnapshot(input);
  const next = await conversationGitService.workerAction(input.sessionId, binding.objectId, {
    action, skipChecks, expectedVersion: snapshot.mr.version, expectedTaskRevision: snapshot.task.revision,
    requestId: requestId(input),
  });
  return result(compact(next), `${action} completed`);
}
function workerTool(id: string, description: string, schema: z.ZodType, execute: (input: ToolExecutionInput) => Promise<ToolExecutionResult>): RegisteredTool {
  return { id, label: id, description,
    progressiveDetails: 'Internal-only tool for the dedicated merge worker. The task binding comes from the worker session.',
    category: 'task', internalGate: 'none', mutability: 'task', resumeBehavior: 'none', inputSchema: schema, getPattern: () => id, execute: async input => {
      const value = await execute(input);
      mergeWorkerWatchdog.progress(input.sessionId, `tool:${input.toolCallId}`);
      return value;
    } };
}

export const conversationMergeWorkerTools: RegisteredTool[] = [
  workerTool('git.merge.worker.inspect', 'Inspect the bound merge task before taking the next internal step.', empty, async input => result(compact((await workerSnapshot(input)).snapshot), 'merge task inspected')),
  workerTool('git.merge.worker.prepare', 'Create the isolated worktree and run the real Git merge.', empty, input => workerAction(input, 'prepare')),
  workerTool('git.merge.worker.files', 'List files currently requiring a resolution.', empty, async input => { const { snapshot } = await workerSnapshot(input); const files = await conversationGitService.gitMr.files(snapshot.task.projectId, snapshot.mr.id); return result(files, `${files.filter(file => file.conflicted).length} conflict files`); }),
  workerTool('git.merge.worker.read', 'Read one bounded side. Partial previews require byteOffset=nextByteOffset and expectedRevision for subsequent pages; never treat a preview as complete.', readInput, async input => {
    const { binding } = await workerSnapshot(input); const args = readInput.parse(argsOf(input));
    if (args.byteOffset !== undefined && args.expectedRevision) {
      const page = await conversationGitService.fileSlice(binding.parentSessionId, binding.objectId, args.fileId, { side: args.side, byteOffset: args.byteOffset, maxBytes: Math.max(4, args.limit), expectedRevision: args.expectedRevision }, input.abortSignal);
      return result({ fileId: args.fileId, side: args.side, ...page, contentState: 'partial', editable: false, truncated: !page.eof }, 'bounded conflict page read');
    }
    const file = await conversationGitService.file(binding.parentSessionId, binding.objectId, args.fileId); const content = file[args.side];
    const partial = file.truncatedSides?.includes(args.side) === true;
    if (partial) {
      const page = await conversationGitService.fileSlice(binding.parentSessionId, binding.objectId, args.fileId, { side: args.side, byteOffset: args.offset, maxBytes: Math.max(4, args.limit), expectedRevision: file.revision }, input.abortSignal);
      return result({ fileId: file.id, path: file.path, side: args.side, ...page, offsetUnit: 'bytes', contentState: file.contentState, editable: file.editable, truncated: !page.eof }, 'bounded conflict page read');
    }
    return result({ fileId: file.id, path: file.path, revision: file.revision, side: args.side, offset: args.offset, content: content.slice(args.offset, args.offset + args.limit), totalCharacters: content.length, totalBytes: file.byteSizes?.[args.side], contentState: file.contentState, editable: file.editable, truncated: args.offset + args.limit < content.length }, 'conflict content read');
  }),
  workerTool('git.merge.worker.resolve', 'Write and stage a complete text resolution for one file.', resolveInput, async input => {
    const { binding, snapshot } = await workerSnapshot(input); const args = resolveInput.parse(argsOf(input));
    const next = await conversationGitService.workerSaveFile(input.sessionId, binding.objectId, args.fileId, { expectedVersion: snapshot.mr.version, expectedTaskRevision: snapshot.task.revision, expectedRevision: args.expectedRevision, content: args.content, resolve: true, requestId: requestId(input) });
    return result(compact(next), `resolved ${args.fileId}`);
  }),
  workerTool('git.merge.worker.continue', 'Continue the real Git merge after all conflict files are staged.', empty, input => workerAction(input, 'continue')),
  workerTool('git.merge.worker.recover', 'Reconcile a failed/interrupted merge against actual Git state before continuing. Never reset user files.', empty, input => workerAction(input, 'resume')),
  workerTool('git.merge.worker.checks', 'Run configured verification commands against the candidate.', empty, input => workerAction(input, 'checks')),
  workerTool('git.merge.worker.finalize', 'Apply the candidate after every configured check passes; never skip verification.', empty, async input => {
    const { snapshot } = await workerSnapshot(input);
    if (!snapshot.mr.checks.length) throw new GitMrError('No checks configured. Report waiting_user instead of bypassing verification.', 'CHECKS_REQUIRED');
    return workerAction(input, 'finalize');
  }),
  workerTool('git.merge.worker.waiting', 'Record that the worker cannot safely decide and needs user input.', z.object({ reason: z.string().trim().min(1).max(4_000) }).strict(), async input => {
    const binding = bindingFor(input.sessionId); const reason = z.object({ reason: z.string().trim().min(1).max(4_000) }).parse(argsOf(input)).reason;
    const execution = await conversationGitService.setWorkerExecution(binding.parentSessionId, binding.objectId, { status: 'waiting_user', phase: 'resolving', summary: reason, error: undefined }, binding.epoch);
    return result(execution, 'waiting for user input');
  }),
  workerTool('git.merge.worker.report', 'Send a bounded summary to the parent. Set joinMode=async only when the parent no longer needs to wait.', z.object({ summary: z.string().trim().min(1).max(4_000), joinMode: z.enum(['blocking', 'async']).optional() }).strict(), async input => {
    const { binding, snapshot } = await workerSnapshot(input);
    const args = z.object({ summary: z.string().trim().min(1).max(4_000), joinMode: z.enum(['blocking', 'async']).optional() }).parse(input.args);
    const execution = await conversationGitService.setWorkerExecution(binding.parentSessionId, binding.objectId, { summary: args.summary, joinMode: args.joinMode ?? snapshot.execution!.joinMode }, binding.epoch);
    return result(execution, 'merge summary reported');
  }),
];

const provider: SessionToolProvider = { id: CONVERSATION_MERGE_WORKER_PROVIDER_ID, getTools(sessionId) { try { bindingFor(sessionId); return conversationMergeWorkerTools; } catch { return []; } }, getHooks() { return []; } };

export function ensureConversationMergeWorkerRegistered(): void {
  const profile: AgentProfile = { id: CONVERSATION_MERGE_WORKER_PROFILE_ID, label: 'Git merge worker', kind: 'executor', mode: 'subagent',
    description: 'Internal worker that performs one bound Git merge and reports summaries to its parent.', defaultThinkingMode: 'deep', allowedCapabilities: [...workerTools],
    permissionDefaults: [
      { gate: 'read', pattern: '*', action: 'allow', reason: 'Read the bound isolated merge task.' },
      { gate: 'write', pattern: '*', action: 'allow', reason: 'Write only through merge worker tools.' },
      { gate: 'task', pattern: '*', action: 'deny', reason: 'A merge worker cannot create or delegate tasks.' },
      { gate: 'none', pattern: '*', action: 'allow', reason: 'Internal commands validate their durable worker binding.' },
    ], maxSteps: 48, status: 'active', allowsSubsessions: false, toolProviderId: CONVERSATION_MERGE_WORKER_PROVIDER_ID,
    toolPolicy: { allowParallelReadTools: true, allowSubtasks: false, maxParallelReadTools: 2 },
    loopHints: ['Use only git.merge.worker.* tools.', 'Inspect, prepare, resolve every conflict from all three sides, continue, run configured checks, and finalize. Never skip checks.', 'For failed/interrupted/preparing/checking/applying states after interruption, call git.merge.worker.recover once, inspect the reconciled state and continue. If the target/source changed, report waiting instead of retrying unchanged writes.', 'Report concise milestone summaries. Call git.merge.worker.report(joinMode=async) when the parent may continue independent work.', 'Call git.merge.worker.waiting when a safe decision is impossible or verification is unavailable; then finish this worker turn.'] };
  profileService.register(profile);
  toolRegistry.registerProvider(provider);
}

async function finishWorker(parentSessionId: string, objectId: string, childSessionId: string, epoch: number, error?: unknown) {
  const snapshot = await conversationGitService.get(parentSessionId, objectId); const child = agentRuntimeStore.tryGetSession(childSessionId); const mr = snapshot.mr;
  if (snapshot.execution?.epoch !== epoch) return;
  if (['pausing', 'paused', 'cancelling', 'cancelled', 'cancelled_cleanup_pending', 'waiting_user', 'recovery_required'].includes(snapshot.execution.status)) return;
  if (error) { await conversationGitService.setWorkerExecution(parentSessionId, objectId, { status: 'failed', phase: 'settled', error: error instanceof Error ? error.message : String(error), summary: child?.resultSummary ?? child?.blockedReason ?? undefined }, epoch); return; }
  if (mr.status === 'merged' || mr.status === 'noop') await conversationGitService.setWorkerExecution(parentSessionId, objectId, { status: 'completed', phase: 'settled', summary: child?.resultSummary ?? `Merge ${mr.status}.`, error: undefined });
  else if (mr.status === 'conflicted') await conversationGitService.setWorkerExecution(parentSessionId, objectId, { status: 'waiting_user', phase: 'resolving', summary: child?.resultSummary ?? 'The worker stopped with unresolved conflicts.' });
  else if (child?.status === 'waiting_input' || child?.status === 'waiting_permission') await conversationGitService.setWorkerExecution(parentSessionId, objectId, { status: 'waiting_user', phase: 'resolving', summary: child.blockedReason ?? 'The merge worker requires input.' });
  else if (!['cancelled', 'paused'].includes(snapshot.execution?.status ?? '')) await conversationGitService.setWorkerExecution(parentSessionId, objectId, { status: 'failed', phase: 'settled', error: child?.blockedReason ?? `Merge worker ended as ${child?.status ?? 'unknown'}.` });
}
function progressDeadline(): number {
  const test = process.env.SYNAX_RUNTIME_TEST_MODE === '1' ? Number(process.env.SYNAX_MERGE_WORKER_IDLE_MS) : NaN;
  return Number.isFinite(test) && test >= 100 ? test : MERGE_WORKER_PROGRESS_TIMEOUT_MS;
}
async function driveWorker(parentSessionId: string, objectId: string, childSessionId: string, epoch: number, prompt: string, mode: 'turn' | 'continue' = 'turn') {
  const watchdog = mergeWorkerWatchdog.watch(childSessionId, async () => {
    const current = await conversationGitService.workerSnapshot(parentSessionId, objectId);
    if (current.execution?.epoch !== epoch || current.execution.childSessionId !== childSessionId) return;
    const settled = ['completed', 'cancelled', 'cancelled_cleanup_pending', 'paused', 'waiting_user', 'recovery_required'].includes(current.execution.status);
    let publicationError: unknown;
    if (!settled) try {
      await conversationGitService.setWorkerExecution(parentSessionId, objectId, {
        status: 'recovery_required', phase: 'settled', error: 'Merge worker made no progress before its deadline.',
        summary: '合并执行器长时间无进展，已暂停写入；继续将核对真实 Git 状态。',
      }, epoch);
    } catch (error) { publicationError = error; }
    try {
      const { interruptAgentSessionsAndWait } = await import('../agent-stream-proxy.js');
      await withDeadline(interruptAgentSessionsAndWait([childSessionId], 'Merge worker progress deadline expired.'),
        10_000, 'Merge worker shutdown could not be confirmed.');
      if (publicationError) throw publicationError;
    } catch (error) {
      if (!settled) await conversationGitService.setWorkerExecution(parentSessionId, objectId, {
        status: 'recovery_required', phase: 'settled', error: error instanceof Error ? error.message : String(error),
        summary: '合并写入已阻止，但执行器停止尚未确认；继续前将再次核对。',
      });
      throw error;
    }
  }, progressDeadline());
  try {
    const execution = (async () => {
      await conversationGitService.awaitWorkerAdmission(objectId);
      await runCoordinator.submitAsync(childSessionId, { message: prompt }, `${mode === 'turn' ? 'merge-worker' : 'merge-worker-resume'}:${objectId}:${epoch}`, mode);
      await runCoordinator.waitForSessionIdle(childSessionId);
    })();
    await Promise.race([execution, watchdog.expired.then(error => { throw error ?? new Error('Merge progress deadline expired.'); })]);
    if (!watchdog.timedOut) await finishWorker(parentSessionId, objectId, childSessionId, epoch);
  } catch (error) {
    if (!watchdog.timedOut) await finishWorker(parentSessionId, objectId, childSessionId, epoch, error).catch(() => undefined);
  } finally {
    watchdog.dispose();
    if (activeWorkers.get(objectId)?.childSessionId === childSessionId && activeWorkers.get(objectId)?.epoch === epoch) activeWorkers.delete(objectId);
  }
}

async function startWorker(parentSessionId: string, objectId: string, replaceMissing = false): Promise<ConversationGitSnapshot> {
  ensureConversationMergeWorkerRegistered();
  await agentRuntimeStore.hydrateSessionSummary(parentSessionId, true);
  const parent = agentRuntimeStore.getSession(parentSessionId);
  if (parent.sessionMetadata?.manualStop || parent.sessionMetadata?.runtimeControl || ['paused', 'stopping', 'cancelled', 'interrupted', 'failed'].includes(parent.status))
    throw new GitMrError('Continue the parent conversation before starting its merge worker.', 'PARENT_STOPPED', 409);
  const joinMode = parent.status === 'completed' ? 'async' as const : 'blocking' as const;
  const current = await conversationGitService.get(parentSessionId, objectId);
  if (current.execution && !replaceMissing) {
    const childId = current.execution.childSessionId;
    if (childId) { await ensureSessionRecovered(childId); await agentRuntimeStore.hydrateSessionSummary(childId, true); }
    const child = childId ? agentRuntimeStore.tryGetSession(childId) : undefined;
    if (child && ['queued', 'running'].includes(current.execution.status) && child.status === 'completed') {
      await finishWorker(parentSessionId, objectId, child.id, current.execution.epoch);
      return conversationGitService.get(parentSessionId, objectId);
    }
    if (['queued', 'running'].includes(current.execution.status) && (!child || ['failed', 'cancelled', 'interrupted'].includes(child.status))) {
      await conversationGitService.setWorkerExecution(parentSessionId, objectId, { status: 'recovery_required', phase: 'settled', summary: '合并执行器已中断；继续将核对真实 Git 状态后恢复。' });
      return conversationGitService.get(parentSessionId, objectId);
    }
    return current;
  }
  const epoch = (current.execution?.epoch ?? 0) + 1;
  const prompt = `Perform bound local Git merge task object ${objectId}. Use only git.merge.worker.* tools. Inspect, prepare isolated merge, resolve conflicts, continue, run checks and finalize. Never ask the user. If unsafe, call git.merge.worker.waiting.`;
  const child = agentSessionRuntime.create({ projectId: current.task.projectId, profileId: CONVERSATION_MERGE_WORKER_PROFILE_ID, parentSessionId, backendId: 'native', mcpServerIds: [], skillIds: [], prompt, thinkingMode: 'deep', sessionMetadata: { mode: 'chat', titleSummarized: true, [bindingKey]: { parentSessionId, objectId, projectId: current.task.projectId, epoch, supervisorPid: process.pid }, subagentTask: { joinMode, state: 'running', phase: 'starting' } } });
  agentRuntimeStore.updateSession(child.id, { title: `合并：${current.mr.title}` });
  await agentRuntimeStore.flushSession(child.id);
  await conversationGitService.setWorkerExecution(parentSessionId, objectId, { status: 'queued', phase: 'preparing', childSessionId: child.id, joinMode, epoch, summary: 'Merge worker queued.' });
  await conversationGitService.setWorkerExecution(parentSessionId, objectId, { status: 'running', phase: 'preparing', summary: 'Merge worker started.' });
  const running: WorkerState = { childSessionId: child.id, epoch, promise: Promise.resolve() }; running.promise = driveWorker(parentSessionId, objectId, child.id, epoch, prompt); activeWorkers.set(objectId, running);
  return conversationGitService.get(parentSessionId, objectId);
}
export async function startConversationMergeWorker(parentSessionId: string, objectId: string, replaceMissing = false): Promise<ConversationGitSnapshot> {
  // Validate ownership before sharing an in-flight start across callers.
  await conversationGitService.workerSnapshot(parentSessionId, objectId);
  const existing = launches.get(objectId); if (existing) return existing;
  const launch = outsideExecutionContext(() => conversationGitService.store.exclusive(`merge-worker-start:${objectId}`, () => startWorker(parentSessionId, objectId, replaceMissing)));
  launches.set(objectId, launch);
  try { return await launch; } finally { if (launches.get(objectId) === launch) launches.delete(objectId); }
}
export async function waitForConversationMergeWorker(parentSessionId: string, snapshot: ConversationGitSnapshot, signal?: AbortSignal): Promise<ConversationGitSnapshot> {
  const childSessionId = snapshot.execution?.childSessionId;
  if (!childSessionId || snapshot.execution?.joinMode === 'async') return snapshot;
  const { subagentCompletionBroker } = await import('../subagent-control-broker.js');
  await subagentCompletionBroker.recover(parentSessionId, childSessionId);
  const outcome = await subagentCompletionBroker.wait({ parentSessionId, childSessionIds: [childSessionId], signal });
  if (outcome.event) await subagentCompletionBroker.acknowledge(parentSessionId, childSessionId, outcome.event.eventSeq);
  return conversationGitService.get(parentSessionId, snapshot.task.id);
}
export async function pauseConversationMergeWorker(parentSessionId: string, objectId: string): Promise<ConversationGitSnapshot> {
  ensureConversationMergeWorkerRegistered();
  const snapshot = await conversationGitService.get(parentSessionId, objectId); const childId = snapshot.execution?.childSessionId; if (!childId) return snapshot;
  await agentRuntimeStore.hydrateSessionSummary(childId, true);
  const pausing = await conversationGitService.setWorkerExecution(parentSessionId, objectId, { status: 'pausing', phase: snapshot.execution?.phase ?? 'resolving', summary: 'Stopping merge worker.' });
  if (['completed', 'cancelled'].includes(pausing.status)) return conversationGitService.get(parentSessionId, objectId);
  try { const { interruptAgentSessionsAndWait } = await import('../agent-stream-proxy.js'); await interruptAgentSessionsAndWait([childId], 'Merge worker paused by the user.'); await runCoordinator.waitForSessionIdle(childId); await activeWorkers.get(objectId)?.promise; }
  catch (error) { await conversationGitService.setWorkerExecution(parentSessionId, objectId, { status: 'recovery_required', phase: 'settled', error: error instanceof Error ? error.message : String(error) }); throw error; }
  await conversationGitService.setWorkerExecution(parentSessionId, objectId, { status: 'paused', phase: snapshot.execution?.phase ?? 'resolving', summary: 'Merge worker paused; isolated candidate retained.' }); return conversationGitService.get(parentSessionId, objectId);
}
export async function resumeConversationMergeWorker(parentSessionId: string, objectId: string): Promise<ConversationGitSnapshot> {
  ensureConversationMergeWorkerRegistered();
  const snapshot = await conversationGitService.get(parentSessionId, objectId); if (['completed', 'cancelled'].includes(snapshot.execution?.status ?? '')) return snapshot; if (activeWorkers.has(objectId)) return snapshot;
  if (snapshot.execution?.status === 'cancelled_cleanup_pending') { await conversationGitService.cancelWorkerMr(parentSessionId, objectId); return conversationGitService.get(parentSessionId, objectId); }
  await agentRuntimeStore.hydrateSessionSummary(parentSessionId, true);
  const parent = agentRuntimeStore.getSession(parentSessionId);
  if (parent.sessionMetadata?.manualStop || parent.sessionMetadata?.runtimeControl || ['paused', 'stopping', 'cancelled', 'interrupted', 'failed'].includes(parent.status))
    throw new GitMrError('Continue the parent conversation before resuming its merge worker.', 'PARENT_STOPPED', 409);
  const joinMode = parent.status === 'completed' ? 'async' as const : 'blocking' as const;
  const childId = snapshot.execution?.childSessionId; if (!childId) return startConversationMergeWorker(parentSessionId, objectId, true);
  await ensureSessionRecovered(childId);
  await agentRuntimeStore.hydrateSessionSummary(childId, true);
  const child = agentRuntimeStore.tryGetSession(childId); if (!child) return startConversationMergeWorker(parentSessionId, objectId, true);
  const epoch = (snapshot.execution?.epoch ?? 0) + 1; const prompt = `Continue merge task ${objectId} from durable state. Inspect first, resolve remaining conflicts, run checks and finalize. Use only git.merge.worker.* tools.`;
  await runCoordinator.reconcileFencedSession(child.id);
  agentRuntimeStore.updateSessionMetadata(child.id, { [bindingKey]: { parentSessionId, objectId, projectId: child.projectId, epoch, supervisorPid: process.pid }, subagentTask: { joinMode, state: 'running', phase: 'resuming' } });
  await conversationGitService.setWorkerExecution(parentSessionId, objectId, { status: 'running', phase: snapshot.execution?.phase ?? 'resolving', epoch, joinMode, summary: 'Merge worker resumed.' });
  const running: WorkerState = { childSessionId: child.id, epoch, promise: Promise.resolve() }; running.promise = outsideExecutionContext(() => driveWorker(parentSessionId, objectId, child.id, epoch, prompt, 'continue')); activeWorkers.set(objectId, running); return conversationGitService.get(parentSessionId, objectId);
}
export async function cancelConversationMergeWorker(parentSessionId: string, objectId: string): Promise<ConversationGitSnapshot> {
  ensureConversationMergeWorkerRegistered();
  const snapshot = await conversationGitService.get(parentSessionId, objectId); const childId = snapshot.execution?.childSessionId;
  if (childId) {
    await agentRuntimeStore.hydrateSessionSummary(childId, true);
    const cancelling = await conversationGitService.setWorkerExecution(parentSessionId, objectId, { status: 'cancelling', epoch: (snapshot.execution?.epoch ?? 0) + 1, phase: snapshot.execution?.phase ?? 'resolving', summary: 'Cancelling merge worker.' });
    if (['completed', 'cancelled'].includes(cancelling.status)) return conversationGitService.get(parentSessionId, objectId);
    try { const { interruptAgentSessionsAndWait } = await import('../agent-stream-proxy.js'); await interruptAgentSessionsAndWait([childId], 'Merge cancelled by the user.'); await runCoordinator.waitForSessionIdle(childId); await activeWorkers.get(objectId)?.promise; }
    catch (error) { await conversationGitService.setWorkerExecution(parentSessionId, objectId, { status: 'recovery_required', phase: 'settled', error: error instanceof Error ? error.message : String(error) }); throw error; }
  }
  await conversationGitService.cancelWorkerMr(parentSessionId, objectId); return conversationGitService.get(parentSessionId, objectId);
}
