import { createHash, randomUUID } from 'node:crypto';
import { GitMrService, gitMrService } from '../../git-mr/service.js';
import { GitMrStore, gitMrStore } from '../../git-mr/store.js';
import { GitMrError } from '../../git-mr/errors.js';
import { branchOid, git, inspect } from '../../git-mr/repository.js';
import type { MergeRequest, MergeRequestInput, MergeProposal, MergeCheckConfig } from '../../git-mr/contracts.js';
import { workspaceRootLocation, type ProjectWorkspaceRoot } from '../../project-workspace.js';
import { canonicalizeWorkspaceLocation, type WorkspaceLocation } from '../../workspace-location.js';
import { resolveSessionWorkspaceRoots } from '../tools/workspace.js';
import { agentRuntimeStore } from '../session-store.js';
import { emitSessionLive } from '../../../infrastructure/runtime/ipc/agent-session-protocol.js';
import { outsideExecutionContext } from '../../../infrastructure/runtime/execution-context.js';
import { runtimeFacade } from '../sidecar/runtime-facade.js';
import { ensureSessionRecovered } from '../session-recovery.js';
import type { AgentRuntimeMessage } from '../contracts.js';
import type {
  ConversationGitAction, ConversationGitApplyProposal, ConversationGitCommit,
  ConversationGitCreate, ConversationGitReference, ConversationGitSave,
  ConversationGitSnapshot, ConversationGitTask,
  ConversationMergeExecution, ConversationGitStateEvent,
} from './contracts.js';

type RuntimeStore = {
  getSession(id: string): { id: string; projectId: string };
  appendMessage(message: AgentRuntimeMessage): AgentRuntimeMessage;
  flushSession(sessionId: string): Promise<void>;
};
export interface ConversationGitServiceOptions {
  gitMr?: GitMrService;
  store?: GitMrStore;
  runtimeStore?: RuntimeStore;
  resolveRoots?: (sessionId: string, projectId: string) => ProjectWorkspaceRoot[];
  emitMessages?: (sessionId: string, messages: AgentRuntimeMessage[]) => void;
  emitState?: (sessionId: string, event: ConversationGitStateEvent) => void;
}
interface StoredTask extends ConversationGitTask {
  rootLocation: WorkspaceLocation;
  repository: string;
  commonDir: string;
  messages: AgentRuntimeMessage[];
  activeRequest?: string;
  execution?: ConversationMergeExecution;
}
interface RequestRecord {
  id: string;
  sessionId: string;
  projectId: string;
  objectId: string;
  operation: string;
  argsHash: string;
  status: 'pending' | 'succeeded' | 'failed';
  pid: number;
  createdAt: string;
  messagesDelivered?: boolean;
  /** Persisted before receipt projection; retries repair projection, never Git. */
  outcome?: { message?: string; error?: { message: string; code: string; status: number } };
  error?: { message: string; code: string; status: number };
  internal?: boolean;
}
type OriginContext = { runId?: string | null; stepId?: string | null; toolCallId?: string | null };
const TASKS = 'conversation-tasks';
const REQUESTS = 'conversation-requests';
const inFlight = new Map<string, { hash: string; promise: Promise<ConversationGitSnapshot> }>();
const shortLocks = new Map<string, Promise<unknown>>();
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
function boundedUtf8(value: string, limit: number): string {
  const bytes = Buffer.from(value, 'utf8');
  if (bytes.length <= limit) return value;
  let end = limit;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return bytes.subarray(0, end).toString('utf8');
}
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
};
const notFound = () => new GitMrError('Conversation merge task not found.', 'NOT_FOUND', 404);
const requestError = (error: unknown) => error instanceof GitMrError
  ? { message: error.message, code: error.code, status: error.status }
  : { message: error instanceof Error ? error.message : String(error), code: 'CONVERSATION_GIT_ERROR', status: 500 };
const taskView = ({ rootLocation: _root, repository: _repo, commonDir: _common, messages: _messages, activeRequest: _request, execution: _execution, ...task }: StoredTask): ConversationGitTask => task;
const recentMessages = (task: StoredTask) => [
  ...task.messages.filter(message => message.id === task.messageId),
  ...task.messages.filter(message => message.id !== task.messageId).slice(-16),
];
/** The inline conflict panel exposes the latest suggestion per file. Earlier
 * proposals remain in GitMrStore and can still be read/applied by their IDs. */
const latestProposals = (proposals: MergeProposal[]) => {
  const latest = new Map<string, MergeProposal>();
  for (const proposal of [...proposals].sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id)))
    latest.set(proposal.fileId, proposal);
  return [...latest.values()];
};

/** Session-scoped durable binding around the existing isolated Git MR engine. */
export class ConversationGitService {
  readonly gitMr: GitMrService;
  readonly store: GitMrStore;
  private readonly runtime: RuntimeStore;
  private readonly roots: NonNullable<ConversationGitServiceOptions['resolveRoots']>;
  private readonly emitMessages: NonNullable<ConversationGitServiceOptions['emitMessages']>;
  private readonly emitState: NonNullable<ConversationGitServiceOptions['emitState']>;
  private readonly reconciliations = new Map<string, Promise<void>>();
  constructor(options: ConversationGitServiceOptions = {}) {
    this.gitMr = options.gitMr ?? gitMrService;
    this.store = options.store ?? options.gitMr?.store ?? gitMrStore;
    this.runtime = options.runtimeStore ?? agentRuntimeStore;
    this.roots = options.resolveRoots ?? resolveSessionWorkspaceRoots;
    this.emitMessages = options.emitMessages ?? ((sessionId, messages) => emitSessionLive(sessionId, { type: 'conversation_git_messages', messages }));
    this.emitState = options.emitState ?? ((sessionId, event) => emitSessionLive(sessionId, event));
  }

  private async lock<T>(identity: string, action: () => Promise<T>): Promise<T> {
    const key = `${this.store.directory}:${identity}`;
    const previous = shortLocks.get(key) ?? Promise.resolve();
    const operation = previous.catch(() => undefined).then(() => this.store.exclusive(identity, action));
    shortLocks.set(key, operation);
    try { return await operation; }
    finally { if (shortLocks.get(key) === operation) shortLocks.delete(key); }
  }

  private async root(sessionId: string, rootId?: string) {
    const session = this.runtime.getSession(sessionId);
    const available = this.roots(sessionId, session.projectId).filter(root => root.status === 'available');
    if (!rootId && available.length > 1)
      throw new GitMrError('Select a workspace root for this merge task.', 'ROOT_REQUIRED', 400);
    const root = rootId ? available.find(item => item.id === rootId) : available[0];
    if (!root) throw new GitMrError('Workspace root is unavailable in this session.', 'ROOT_UNAVAILABLE', 404);
    const location = await canonicalizeWorkspaceLocation(workspaceRootLocation(root));
    return { session, root, location };
  }

  private async binding(sessionId: string, objectId: string) {
    const session = this.runtime.getSession(sessionId);
    const task = await this.store.read<StoredTask>(TASKS, objectId);
    if (task.sessionId !== sessionId || task.projectId !== session.projectId) throw notFound();
    const scope = await this.root(sessionId, task.rootId);
    if (canonical(scope.location) !== canonical(task.rootLocation))
      throw new GitMrError('The session workspace binding changed.', 'WORKSPACE_SCOPE_CHANGED');
    const mr = await this.gitMr.get(session.projectId, task.mrId);
    const repository = await inspect(scope.location);
    if (mr.projectId !== task.projectId || mr.rootId !== task.rootId ||
        mr.repository !== task.repository || mr.commonDir !== task.commonDir ||
        repository.repository !== task.repository || repository.commonDir !== task.commonDir)
      throw new GitMrError('Merge task does not belong to this workspace.', 'WORKSPACE_SCOPE_CHANGED');
    return { task, mr, ...scope };
  }

  private reference(task: ConversationGitTask, mr: MergeRequest): ConversationGitReference {
    return { schema: 'synax.git-merge', schemaVersion: 1, objectId: task.id,
      sessionId: task.sessionId, projectId: task.projectId, rootId: task.rootId, title: mr.title };
  }

  private async stale(mr: MergeRequest): Promise<{ stale: boolean; staleReason?: string }> {
    if (['merged', 'noop'].includes(mr.status)) return { stale: false };
    try {
      if (await branchOid(mr, mr.target) !== mr.targetOid)
        return { stale: true, staleReason: `目标分支 ${mr.target} 已更新，需要重新规划。` };
      for (const step of mr.steps) if (await branchOid(mr, step.branch) !== step.oid)
        return { stale: true, staleReason: `来源分支 ${step.branch} 已更新，需要重新规划。` };
      return { stale: false };
    } catch (error) {
      if (error instanceof GitMrError && ['GIT_COMMAND_FAILED', 'INVALID_BRANCH'].includes(error.code))
        return { stale: true, staleReason: '任务引用的分支已不可用，需要重新规划。' };
      throw error;
    }
  }

  private async commits(mr: MergeRequest): Promise<ConversationGitCommit[]> {
    const refs = new Map<string, string[]>();
    const add = (oid: string | undefined, name: string) => {
      if (oid) refs.set(oid, [...(refs.get(oid) ?? []), name]);
    };
    add(mr.targetOid, mr.status === 'merged' && mr.candidateOid !== mr.targetOid ? `${mr.target} · 合并前` : mr.target);
    for (const step of mr.steps) add(step.oid, step.branch);
    if (mr.candidateOid && mr.candidateOid !== mr.targetOid) add(mr.candidateOid, mr.status === 'merged' ? mr.target : '合并候选');
    const result = await git(mr, ['log', '--topo-order', '--max-count=30', '-z',
      '--format=%H%x00%P%x00%s%x00%an%x00%aI', ...refs.keys(), '--']);
    const parts = result.stdout.split('\0');
    const commits: ConversationGitCommit[] = [];
    for (let i = 0; i + 4 < parts.length; i += 5) {
      const [oid, parents, subject, author, date] = parts.slice(i, i + 5);
      if (!/^[a-f0-9]{40,64}$/.test(oid)) continue;
      commits.push({ oid, parents: parents ? parents.split(' ') : [], subject, author, date, refs: refs.get(oid) ?? [] });
    }
    return commits;
  }

  async get(sessionId: string, objectId: string): Promise<ConversationGitSnapshot> {
    let { task, mr } = await this.binding(sessionId, objectId);
    await this.reconcilePendingOnRead(sessionId, objectId);
    ({ task, mr } = await this.binding(sessionId, objectId));
    const fileSnapshot = this.gitMr.files(task.projectId, mr.id).catch(error => {
      // prepare persists its destination before git worktree add creates it.
      // Polls during that short window still need the preparing task state.
      if (mr.status === 'preparing' && error instanceof GitMrError &&
          ['GIT_COMMAND_FAILED', 'COMMAND_FAILED'].includes(error.code)) return [];
      throw error;
    });
    const [files, proposals, commits, stale] = await Promise.all([
      fileSnapshot, this.gitMr.proposals(task.projectId, mr.id), this.commits(mr), this.stale(mr),
    ]);
    // Bound polling history without pruning either durable task receipts or the
    // runtime transcript. Full proposal content is retained for accurate review.
    return { task: taskView(task), reference: this.reference(task, mr), mr, files, execution: task.execution,
      proposals: latestProposals(proposals), commits, ...stale, messages: recentMessages(task) };
  }

  /**
   * Repair a request that was durably reserved before a process/runtime crash.
   * The persisted session/run state is authoritative; the request PID is only
   * diagnostic and is intentionally never used to decide that remote work is
   * still active.
   */
  private async reconcilePendingOnRead(sessionId: string, objectId: string): Promise<void> {
    const key = `${this.store.directory}:${objectId}`;
    const existing = this.reconciliations.get(key);
    if (existing) return existing;
    let repaired: { task: StoredTask; mr: MergeRequest } | undefined;
    const task = this.lock(`conversation-task:${objectId}`, async () => {
      const stored = await this.store.read<StoredTask>(TASKS, objectId);
      if (stored.sessionId !== sessionId) throw notFound();
      const request = stored.activeRequest ? await this.readRequest(stored.activeRequest) : undefined;
      if (request?.status === 'pending' && request.outcome) {
        const failure = request.outcome.error;
        await this.finishLocked(request, failure ? new GitMrError(failure.message, failure.code, failure.status) : undefined, request.outcome.message);
        return;
      }
      if (request && (request.status !== 'pending' || inFlight.has(`${this.store.directory}:${request.id}`))) return;
      if (!request && !['queued', 'running', 'pausing', 'cancelling'].includes(stored.execution?.status ?? '')) return;
      if (stored.execution) {
        const { hasLocalConversationMergeWorker } = await import('./worker.js');
        if (hasLocalConversationMergeWorker(objectId)) return;
      }
      const mr = await this.gitMr.get(stored.projectId, stored.mrId);
      if (await this.store.operationActive(mr.commonDir)) return;

      // A finalize write may have reached Git before the request journal did.
      if (request?.operation === 'finalize' && mr.status === 'merged' && mr.candidateOid &&
          mr.application?.candidateOid === mr.candidateOid && await branchOid(mr, mr.target) === mr.candidateOid) {
        request.outcome = { message: `合并完成，目标分支 ${mr.target} 已更新。` };
        await this.store.write(REQUESTS, request);
        await this.finishLocked(request, undefined, request.outcome.message);
        return;
      }

      let childActive = false;
      let childStatus: string | undefined;
      const childId = stored.execution?.childSessionId;
      if (childId) {
        await ensureSessionRecovered(childId);
        await agentRuntimeStore.hydrateSessionSummary(childId, true);
        const child = agentRuntimeStore.tryGetSession(childId);
        childStatus = child?.status;
        const control = await runtimeFacade.controlState(childId) as { executionLease?: { runId?: string; closed?: boolean }; runtimeControl?: unknown };
        childActive = Boolean(child?.activeRunId && control.executionLease?.closed === false &&
          control.executionLease.runId === child.activeRunId && ['queued', 'running', 'waiting_permission', 'waiting_input'].includes(child.status));
      }
      if (childActive) return;
      if (childStatus && ['running', 'queued'].includes(childStatus)) {
        await agentRuntimeStore.hydrateSessionSummary(sessionId, true);
        const parent = agentRuntimeStore.tryGetSession(sessionId);
        const control = await runtimeFacade.controlState(sessionId) as { executionLease?: { runId?: string; closed?: boolean } };
        // The parent owns the tiny child-admission window before a run exists.
        if (parent?.activeRunId && control.executionLease?.closed === false && control.executionLease.runId === parent.activeRunId) return;
      }
      if (request && ((request.operation === 'pause' && stored.execution?.status === 'paused') ||
          (request.operation === 'cancel' && ['cancelled', 'completed'].includes(stored.execution?.status ?? '')))) {
        request.outcome = { message: request.operation === 'pause' ? '合并已停止，候选结果已保留。' : '此次合并已取消。' };
        await this.store.write(REQUESTS, request);
        await this.finishLocked(request, undefined, request.outcome.message);
        return;
      }

      const reason = stored.execution
        ? '合并执行器在操作完成前中断；请继续以核对真实 Git 状态。'
        : ['preparing', 'checking', 'applying', 'interrupted'].includes(mr.status)
          ? 'Git 合并操作在进程重启时中断；请继续以恢复真实状态。'
          : '合并请求在写入操作结果前中断；请继续以恢复。';
      if (stored.execution && ['queued', 'running', 'pausing', 'cancelling'].includes(stored.execution.status)) {
        stored.execution = { ...stored.execution, status: 'recovery_required', phase: 'settled', error: reason,
          summary: stored.execution.summary ?? reason, updatedAt: new Date().toISOString(), revision: stored.execution.revision + 1 };
        stored.revision += 1;
        stored.updatedAt = stored.execution.updatedAt;
        await this.store.write(TASKS, stored);
        repaired = { task: stored, mr };
      }
      if (request) {
        request.outcome = { error: { message: reason, code: 'OPERATION_INTERRUPTED', status: 409 } };
        await this.store.write(REQUESTS, request);
        await this.finishLocked(request, new GitMrError(reason, 'OPERATION_INTERRUPTED', 409), reason);
      }
    }).then(async () => { if (repaired) await this.publishWorkerExecution(repaired.task, repaired.mr); });
    this.reconciliations.set(key, task);
    try { await task; } finally { if (this.reconciliations.get(key) === task) this.reconciliations.delete(key); }
  }

  /** Internal worker reads never rescan history, proposals or every file. */
  async workerSnapshot(sessionId: string, objectId: string): Promise<ConversationGitSnapshot> {
    const { task, mr } = await this.binding(sessionId, objectId);
    return { task: taskView(task), reference: this.reference(task, mr), mr, execution: task.execution,
      files: [], proposals: [], commits: [], messages: [], stale: false };
  }

  async list(sessionId: string): Promise<ConversationGitSnapshot[]> {
    const session = this.runtime.getSession(sessionId);
    const tasks = (await this.store.list<StoredTask>(TASKS, session.projectId))
      .filter(task => task.sessionId === sessionId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return Promise.all(tasks.map(task => this.get(sessionId, task.id)));
  }

  async file(sessionId: string, objectId: string, fileId: string, signal?: AbortSignal) {
    const { task, mr } = await this.binding(sessionId, objectId);
    return this.gitMr.file(task.projectId, mr.id, fileId, signal);
  }
  async fileSlice(sessionId: string, objectId: string, fileId: string, input: import('../../git-mr/contracts.js').MergeFileSliceInput, signal?: AbortSignal) {
    const { task, mr } = await this.binding(sessionId, objectId);
    return this.gitMr.fileSlice(task.projectId, mr.id, fileId, input, signal);
  }

  private requestId(sessionId: string, requestId: string) {
    if (typeof requestId !== 'string' || !requestId.trim() || requestId.length > 160 || /[\x00-\x1f]/.test(requestId))
      throw new GitMrError('A valid requestId is required.', 'INVALID_REQUEST_ID', 400);
    return digest(`${sessionId}\0${requestId}`);
  }

  private async readRequest(id: string) {
    return this.store.read<RequestRecord>(REQUESTS, id).catch(error => {
      if (error instanceof GitMrError && error.code === 'NOT_FOUND') return undefined;
      throw error;
    });
  }

  private version(task: StoredTask, mr: MergeRequest, expectedTaskRevision: number, expectedVersion: number) {
    if (!Number.isInteger(expectedTaskRevision) || expectedTaskRevision !== task.revision)
      throw new GitMrError('Merge task changed; refresh before continuing.', 'STALE_TASK_REVISION');
    if (!Number.isInteger(expectedVersion) || expectedVersion !== mr.version)
      throw new GitMrError('Merge request changed; refresh before continuing.', 'STALE_VERSION');
  }

  private async persistMessages(task: StoredTask, receiptId?: string) {
    const messages = task.messages.filter(message => message.id === task.messageId || message.id === receiptId);
    for (const message of messages) this.runtime.appendMessage(message);
    await this.runtime.flushSession(task.sessionId);
    this.emitMessages(task.sessionId, messages);
  }

  private async finish(record: RequestRecord, error?: unknown, message?: string) {
    await this.lock(`conversation-task:${record.objectId}`, () => this.finishLocked(record, error, message));
  }

  private async finishLocked(record: RequestRecord, error?: unknown, message?: string) {
    const task = await this.store.read<StoredTask>(TASKS, record.objectId);
    const mr = await this.gitMr.get(task.projectId, task.mrId);
    const receiptId = record.internal ? `git-worker-receipt-${task.id}` : `git-receipt-${record.id}`;
    if (!task.messages.some(item => item.id === receiptId && item.metadata.requestId === record.id)) {
      task.revision += 1;
      task.updatedAt = new Date().toISOString();
      if (task.activeRequest === record.id) delete task.activeRequest;
      const reference = this.reference(task, mr);
      task.messages[0] = { ...task.messages[0], metadata: { ...task.messages[0].metadata,
        gitMergeTask: reference, gitMergeState: { status: mr.status, revision: task.revision, mrVersion: mr.version } } };
      const receipt: AgentRuntimeMessage = { id: receiptId, sessionId: task.sessionId, runId: null, stepId: null,
        role: 'assistant', content: message ?? (error ? `合并任务操作未完成：${requestError(error).message}` : `合并任务已更新：${mr.status}。`),
        metadata: { source: 'git_merge_receipt', gitMergeTask: reference, operation: record.operation, requestId: record.id,
          status: error ? 'failed' : 'succeeded', mrStatus: mr.status }, createdAt: task.updatedAt };
      if (record.internal) task.messages = [task.messages[0], receipt];
      else task.messages.push(receipt);
      await this.store.write(TASKS, task);
    }
    record.status = error ? 'failed' : 'succeeded';
    record.error = error ? requestError(error) : undefined;
    await this.store.write(REQUESTS, record);
    // The Git outcome is durable before cross-store delivery. A retry may
    // re-upsert these stable message IDs, but must never repeat the Git write.
    await this.persistMessages(task, receiptId);
    record.messagesDelivered = true;
    await this.store.write(REQUESTS, record);
  }

  private async execute(
    sessionId: string, objectId: string, requestId: string, operation: string, args: unknown,
    validate: (task: StoredTask, mr: MergeRequest) => Promise<void>,
    work: (task: StoredTask, mr: MergeRequest) => Promise<string | void>,
    runtimeOnly = false,
  ): Promise<ConversationGitSnapshot> {
    // Scope validation precedes even a cached request lookup.
    await this.binding(sessionId, objectId);
    await this.reconcilePendingOnRead(sessionId, objectId);
    const id = this.requestId(sessionId, requestId);
    const hash = digest(canonical({ objectId, operation, args }));
    const flightKey = `${this.store.directory}:${id}`;
    const running = inFlight.get(flightKey);
    if (running) {
      if (running.hash !== hash) throw new GitMrError('requestId was reused with different arguments.', 'IDEMPOTENCY_CONFLICT');
      return running.promise;
    }
    const promise = (async () => {
      let cached = false;
      let reserved: RequestRecord | undefined;
      let target: { task: StoredTask; mr: MergeRequest } | undefined;
      await this.lock(`conversation-request:${id}`, () => this.lock(`conversation-task:${objectId}`, async () => {
        const { task, mr } = await this.binding(sessionId, objectId);
        const prior = await this.readRequest(id);
        if (prior) {
          if (prior.argsHash !== hash) throw new GitMrError('requestId was reused with different arguments.', 'IDEMPOTENCY_CONFLICT');
          // A crash can occur after Git's durable ref update but before the
          // outcome journal write. Reconcile this narrow terminal case from
          // real Git; never call finalize again for the same pending request.
          if (prior.status === 'pending' && !prior.outcome && prior.operation === 'finalize' &&
              task.activeRequest === prior.id && mr.status === 'merged' && mr.candidateOid &&
              mr.application?.candidateOid === mr.candidateOid && await branchOid(mr, mr.target) === mr.candidateOid) {
            prior.outcome = { message: `合并完成，目标分支 ${mr.target} 已更新。` };
            await this.store.write(REQUESTS, prior);
          }
          if (prior.status === 'pending' && prior.outcome) {
            const failure = prior.outcome.error;
            await this.finishLocked(prior, failure ? new GitMrError(failure.message, failure.code, failure.status) : undefined, prior.outcome.message);
          }
          if (prior.status !== 'pending' && !prior.messagesDelivered) {
            await this.persistMessages(task, prior.internal ? `git-worker-receipt-${task.id}` : `git-receipt-${prior.id}`);
            prior.messagesDelivered = true;
            await this.store.write(REQUESTS, prior);
          }
          if (prior.status === 'failed') throw new GitMrError(prior.error!.message, prior.error!.code, prior.error!.status);
          if (prior.status === 'pending') throw new GitMrError('The request is already running or awaiting recovery.', 'OPERATION_PENDING');
          cached = true;
          return;
        }
        if (task.activeRequest) {
          const active = await this.readRequest(task.activeRequest);
          const canStop = ['cancel', 'pause'].includes(operation) && (Boolean(task.execution) || active?.operation === 'checks');
          if (active?.status === 'pending' && !canStop) {
            throw new GitMrError('A task operation still owns a live execution or Git operation.', 'TASK_BUSY');
          }
        }
        await validate(task, mr);
        reserved = { id, sessionId, projectId: task.projectId, objectId, operation, argsHash: hash,
          status: 'pending', pid: process.pid, createdAt: new Date().toISOString(), internal: runtimeOnly || undefined };
        await this.store.write(REQUESTS, reserved);
        if (!(['cancel', 'pause'].includes(operation) && task.activeRequest)) task.activeRequest = id;
        await this.store.write(TASKS, task);
        target = { task, mr };
      }));
      if (cached) return runtimeOnly ? this.workerSnapshot(sessionId, objectId) : this.get(sessionId, objectId);
      let error: unknown;
      let message: string | void;
      try { message = await work(target!.task, target!.mr); }
      catch (failure) { error = failure; }
      reserved!.outcome = { message: message! || undefined, error: error ? requestError(error) : undefined };
      await this.store.write(REQUESTS, reserved!);
      await this.finish(reserved!, error, message!);
      if (error) throw error;
      return runtimeOnly ? this.workerSnapshot(sessionId, objectId) : this.get(sessionId, objectId);
    })();
    inFlight.set(flightKey, { hash, promise });
    try { return await promise; } finally { inFlight.delete(flightKey); }
  }

  async create(sessionId: string, input: ConversationGitCreate, context: OriginContext | null = {}): Promise<ConversationGitSnapshot> {
    const { session, root, location } = await this.root(sessionId, input.rootId);
    const id = this.requestId(sessionId, input.requestId);
    const createInput: MergeRequestInput = { rootId: root.id, title: input.title, target: input.target,
      sources: input.sources, strategy: input.strategy, checks: input.checks, allowCheckedOutTarget: input.allowCheckedOutTarget, autoFinalize: false };
    const hash = digest(canonical({ operation: 'create', input: createInput }));
    // Creation is short and has no checks or Git publication, so its request lock
    // can span draft creation. Subsequent task operations only use short locks.
    return this.lock(`conversation-request:${id}`, async () => {
      const prior = await this.readRequest(id);
      if (prior) {
        if (prior.argsHash !== hash || prior.projectId !== session.projectId)
          throw new GitMrError('requestId was reused with different arguments.', 'IDEMPOTENCY_CONFLICT');
        if (prior.status === 'failed') throw new GitMrError(prior.error!.message, prior.error!.code, prior.error!.status);
        if (prior.status === 'pending') throw new GitMrError('Creation is awaiting recovery.', 'OPERATION_PENDING');
        const { task } = await this.binding(sessionId, prior.objectId);
        if (!prior.messagesDelivered) {
          await this.persistMessages(task);
          prior.messagesDelivered = true;
          await this.store.write(REQUESTS, prior);
        }
        return this.get(sessionId, prior.objectId);
      }
      const objectId = randomUUID();
      const record: RequestRecord = { id, objectId, sessionId, projectId: session.projectId, operation: 'create', argsHash: hash,
        status: 'pending', pid: process.pid, createdAt: new Date().toISOString() };
      await this.store.write(REQUESTS, record);
      try {
        const mr = await this.gitMr.create(session.projectId, location, createInput);
        const timestamp = new Date().toISOString();
        const task: StoredTask = { id: objectId, sessionId, projectId: session.projectId, rootId: root.id,
          mrId: mr.id, previousMrIds: [], messageId: `git-task-${objectId}`, createdAt: timestamp, updatedAt: timestamp,
          revision: 1, rootLocation: location, repository: mr.repository, commonDir: mr.commonDir, messages: [] };
        const reference = this.reference(task, mr);
        task.messages.push({ id: task.messageId, sessionId, runId: null, stepId: null, role: 'assistant',
          content: `合并任务：${mr.title}。${mr.steps.map(step => step.branch).join('、')} → ${mr.target}。objectId: ${objectId}`,
          metadata: { source: 'git_merge_task', gitMergeTask: reference,
            originRunId: context?.runId ?? null, originStepId: context?.stepId ?? null, originToolCallId: context?.toolCallId ?? null,
            gitMergeState: { status: mr.status, revision: 1, mrVersion: mr.version } }, createdAt: timestamp });
        await this.store.write(TASKS, task);
        record.status = 'succeeded';
        await this.store.write(REQUESTS, record);
        await this.persistMessages(task);
        record.messagesDelivered = true;
        await this.store.write(REQUESTS, record);
        return this.get(sessionId, objectId);
      } catch (error) {
        if (record.status !== 'succeeded') {
          record.status = 'failed'; record.error = requestError(error);
          await this.store.write(REQUESTS, record);
        }
        throw error;
      }
    });
  }

  async action(sessionId: string, objectId: string, input: ConversationGitAction, workerSessionId?: string) {
    return this.execute(sessionId, objectId, input.requestId, input.action, workerSessionId ? { action: input.action, skipChecks: input.skipChecks } : input, async (task, mr) => {
      this.version(task, mr, input.expectedTaskRevision, input.expectedVersion);
      if (workerSessionId) this.assertWorker(task, workerSessionId);
      else if (task.execution && !['pause', 'resume', 'cancel'].includes(input.action))
        throw new GitMrError('The dedicated worker owns this merge. Stop it before editing or continue it from the task card.', 'WORKER_OWNS_TASK');
      if (!workerSessionId && input.action === 'resume' && task.execution && !['paused', 'waiting_user', 'failed', 'recovery_required', 'cancelled_cleanup_pending'].includes(task.execution.status))
        throw new GitMrError('Only a stopped merge worker can continue.', 'INVALID_STATE');
      if (!['cancel', 'pause', 'resume', 'replan'].includes(input.action)) {
        const freshness = await this.stale(mr);
        if (freshness.stale) throw new GitMrError(freshness.staleReason!, 'STALE_PLAN');
      }
      if (input.action === 'replan' && ['preparing', 'checking', 'applying', 'merged', 'noop'].includes(mr.status))
        throw new GitMrError('Finish or stop the current operation before replanning.', 'INVALID_STATE');
    }, async (task, mr) => {
      // Re-enter from durable progress. Repeated preparation/continuation and
      // recovery after an already reconciled step must not repeat Git writes.
      if (workerSessionId && (
        (input.action === 'prepare' && ['conflicted', 'ready', 'check_failed'].includes(mr.status)) ||
        (input.action === 'continue' && ['ready', 'check_failed'].includes(mr.status)) ||
        (input.action === 'resume' && ['draft', 'conflicted', 'ready', 'check_failed'].includes(mr.status))
      )) return `步骤已完成，继续当前合并状态：${mr.status}。`;
      if (!workerSessionId && (task.execution || input.action === 'pause')) {
        const worker = await import('./worker.js');
        if (input.action === 'pause') { await worker.pauseConversationMergeWorker(sessionId, objectId); return '合并已停止，候选结果已保留。'; }
        if (input.action === 'resume') { await worker.resumeConversationMergeWorker(sessionId, objectId); return '已继续智能合并。'; }
        if (input.action === 'cancel') { await worker.cancelConversationMergeWorker(sessionId, objectId); return '已放弃此次合并。'; }
      }
      if (input.action === 'replan') {
        const next = await this.gitMr.create(task.projectId, task.rootLocation, { rootId: task.rootId, title: mr.title,
          target: mr.target, sources: mr.steps.map(step => step.branch), strategy: mr.strategy,
          checks: mr.checks, allowCheckedOutTarget: mr.allowCheckedOutTarget, autoFinalize: false });
        await this.lock(`conversation-task:${task.id}`, async () => {
          const current = await this.store.read<StoredTask>(TASKS, task.id);
          if (current.mrId !== mr.id) throw new GitMrError('Task changed while replanning.', 'STALE_TASK_REVISION');
          current.previousMrIds.push(mr.id); current.mrId = next.id;
          await this.store.write(TASKS, current);
        });
        return '已基于最新分支重新规划，旧方案保留；请准备新的合并草稿。';
      }
      const methods = { prepare: 'prepare', continue: 'continue', checks: 'checks', finalize: 'finalize', cancel: 'cancel', resume: 'resume', pause: undefined } as const;
      const method = methods[input.action];
      if (!method) throw new GitMrError('Unknown merge action.', 'INVALID_ACTION', 400);
      const guard = workerSessionId ? () => this.assertWorkerCurrent(task.id, workerSessionId) : undefined;
      let outcome: MergeRequest;
      try { outcome = method === 'finalize'
        ? await this.gitMr.finalize(task.projectId, mr.id, input.expectedVersion, { skipChecks: input.skipChecks === true, guard })
        : ['prepare', 'continue', 'checks', 'resume'].includes(method)
          ? await this.gitMr[method as 'prepare' | 'continue' | 'checks' | 'resume'](task.projectId, mr.id, input.expectedVersion, guard)
          : await this.gitMr.cancel(task.projectId, mr.id, input.expectedVersion); }
      catch (error) {
        if (input.action === 'cancel' && error instanceof GitMrError && error.code === 'STOPPING')
          return '已请求停止验证；等待进程退出后可取消任务，草稿将保留。';
        throw error;
      }
      if (input.action === 'cancel' && outcome.status === 'merged')
        return `目标分支 ${mr.target} 已包含候选结果，任务已核实为合并完成。`;
      if (workerSessionId && task.execution) await this.setWorkerExecution(sessionId, objectId, {
        phase: outcome.status === 'conflicted' ? 'resolving' : outcome.status === 'ready' ? 'checking' : ['merged', 'noop'].includes(outcome.status) ? 'settled' : 'preparing',
        ...(outcome.status === 'merged' || outcome.status === 'noop' ? { status: 'completed' as const } : {}),
        summary: outcome.status === 'conflicted' ? '正在解决冲突。' : outcome.status === 'merged' ? `已合并到 ${mr.target}。` : `合并状态：${outcome.status}。`,
      }, task.execution.epoch, true);
      const receipts = { prepare: '已准备隔离合并工作区。', continue: '已保存解决结果并继续合并。', checks: '验证执行已结束，请查看检查结果。', finalize: `${input.skipChecks ? '已按你的选择跳过验证；' : ''}合并完成，目标分支 ${mr.target} 已更新。`, cancel: '合并任务已取消，隔离工作区和草稿已保留。', resume: '已恢复任务，请查看当前 Git 状态。' };
      return receipts[method];
    }, Boolean(workerSessionId));
  }

  async saveFile(sessionId: string, objectId: string, fileId: string, input: ConversationGitSave, workerSessionId?: string) {
    const { expectedTaskRevision: _taskRevision, expectedVersion: _version, ...workerArgs } = input;
    return this.execute(sessionId, objectId, input.requestId, 'save-file', { fileId, ...(workerSessionId ? workerArgs : input) }, async (task, mr) => {
      this.version(task, mr, input.expectedTaskRevision, input.expectedVersion);
      if (workerSessionId) this.assertWorker(task, workerSessionId);
      else if (task.execution && !['paused', 'waiting_user'].includes(task.execution.status))
        throw new GitMrError('Stop the merge worker before editing a conflict.', 'WORKER_OWNS_TASK');
      const freshness = await this.stale(mr);
      if (freshness.stale) throw new GitMrError(freshness.staleReason!, 'STALE_PLAN');
      if (mr.status !== 'conflicted') throw new GitMrError('Only active conflicts can be edited.', 'INVALID_STATE');
      const file = await this.gitMr.file(task.projectId, mr.id, fileId);
      if (file.revision !== input.expectedRevision) throw new GitMrError('Conflict draft changed; reload first.', 'STALE_DRAFT');
    }, async (task, mr) => {
      const saved = await this.gitMr.saveFile(task.projectId, mr.id, fileId, input, input.expectedVersion, workerSessionId ? () => this.assertWorkerCurrent(task.id, workerSessionId) : undefined);
      if (workerSessionId && task.execution) await this.setWorkerExecution(sessionId, objectId, { phase: 'resolving', summary: `已解决：${saved.path}` }, task.execution.epoch, false, [fileId], [{ id: saved.id, path: saved.path, status: saved.status, conflicted: saved.conflicted }]);
      return `${input.resolve ? '已确认解决' : '已保存草稿'}：${saved.path}。`;
    }, Boolean(workerSessionId));
  }

  async applyProposal(sessionId: string, objectId: string, input: ConversationGitApplyProposal) {
    return this.execute(sessionId, objectId, input.requestId, 'apply-proposal', input, async (task, mr) => {
      this.version(task, mr, input.expectedTaskRevision, input.expectedVersion);
      if (task.execution && !['paused', 'waiting_user'].includes(task.execution.status))
        throw new GitMrError('Stop the merge worker before applying a proposal.', 'WORKER_OWNS_TASK');
      const freshness = await this.stale(mr);
      if (freshness.stale) throw new GitMrError(freshness.staleReason!, 'STALE_PLAN');
    }, async (task, mr) => {
      await this.gitMr.applyProposal(task.projectId, mr.id, input.proposalId, input.expectedVersion);
      return '已将建议填入冲突草稿；请检查并确认解决。';
    });
  }

  async propose(sessionId: string, objectId: string, input: Pick<MergeProposal, 'fileId' | 'revision' | 'content' | 'rationale'>) {
    const { task, mr } = await this.binding(sessionId, objectId);
    const freshness = await this.stale(mr);
    if (freshness.stale) throw new GitMrError(freshness.staleReason!, 'STALE_PLAN');
    return this.gitMr.propose(task.projectId, mr.id, input);
  }

  private assertWorker(task: StoredTask, childSessionId: string) {
    const execution = task.execution;
    const child = agentRuntimeStore.tryGetSession(childSessionId);
    const binding = child?.sessionMetadata?.mergeWorker as { objectId?: string; epoch?: number } | undefined;
    if (!execution || execution.childSessionId !== childSessionId || child?.parentSessionId !== task.sessionId ||
      binding?.objectId !== task.id || binding.epoch !== execution.epoch || !['queued', 'running'].includes(execution.status))
      throw new GitMrError('The merge worker authority is stale or stopped.', 'WORKER_FENCED', 409);
  }
  private async assertWorkerCurrent(objectId: string, childSessionId: string) {
    const task = await this.store.read<StoredTask>(TASKS, objectId);
    this.assertWorker(task, childSessionId);
    // Git executes outside the parent's tool lease, but never outside its stop
    // authority. Read the durable fences again at the actual mutation boundary;
    // a worker's cached parent may predate a stop issued by the API process.
    const [parent, child, parentControl, childControl] = await Promise.all([
      runtimeFacade.uiSnapshotAuthoritative(task.sessionId),
      runtimeFacade.uiSnapshotAuthoritative(childSessionId),
      runtimeFacade.controlState(task.sessionId),
      runtimeFacade.controlState(childSessionId),
    ]);
    type Control = { runtimeControl?: unknown; executionLease?: { runId: string; closed?: boolean } };
    const parentFence = parentControl as Control, childFence = childControl as Control;
    const parentStopped = parentFence.runtimeControl || parent.session.sessionMetadata?.runtimeControl || parent.session.sessionMetadata?.manualStop ||
      ['paused', 'stopping', 'cancelled', 'interrupted', 'failed'].includes(parent.session.status);
    const childStopped = childFence.runtimeControl || child.session.sessionMetadata?.runtimeControl || child.session.sessionMetadata?.manualStop ||
      child.session.status !== 'running' || !child.session.activeRunId ||
      childFence.executionLease?.closed !== false || childFence.executionLease?.runId !== child.session.activeRunId;
    const parentReleased = task.execution?.joinMode === 'async' && parent.session.status === 'completed';
    if (parentStopped || childStopped || (parent.session.status !== 'running' && !parentReleased))
      throw new GitMrError('The controlling session or worker execution has been stopped.', 'WORKER_FENCED', 409);
  }

  /** All projections are emitted only after their authority state is durable. */
  async setWorkerExecution(sessionId: string, objectId: string, patch: Partial<ConversationMergeExecution>, fence?: number | { epoch: number; revision: number }, includeFiles = false, changedFileIds?: string[], changedFiles?: ConversationGitSnapshot['files']) {
    const updated = await this.lock(`conversation-task:${objectId}`, async () => {
      const { task, mr } = await this.binding(sessionId, objectId);
      const expectedEpoch = typeof fence === 'object' ? fence.epoch : fence;
      if (expectedEpoch !== undefined && task.execution?.epoch !== expectedEpoch)
        throw new GitMrError('The merge worker generation changed.', 'WORKER_FENCED');
      const reentry = typeof fence === 'object';
      if (reentry && (task.execution?.revision !== fence.revision || patch.epoch !== fence.epoch + 1 ||
          patch.status !== 'running' || !['paused', 'waiting_user', 'failed', 'recovery_required'].includes(task.execution.status)))
        throw new GitMrError('The merge worker changed during re-entry; inspect its latest state before continuing.', 'WORKER_FENCED');
      if (task.execution && ['completed', 'cancelled'].includes(task.execution.status)) return { task, mr };
      if (task.execution?.status === 'cancelled_cleanup_pending' &&
          (expectedEpoch !== undefined || !['cancelled', 'cancelled_cleanup_pending', 'cancelling'].includes(patch.status ?? '')))
        throw new GitMrError('Cancelled merges may only retry isolated candidate cleanup.', 'WORKER_FENCED');
      if (!reentry && expectedEpoch !== undefined && task.execution && ['pausing', 'paused', 'cancelling', 'waiting_user', 'recovery_required'].includes(task.execution.status))
        throw new GitMrError('The merge worker is stopped.', 'WORKER_FENCED');
      task.execution = { status: 'queued', phase: 'preparing', joinMode: 'blocking', epoch: 1, ...task.execution, ...patch,
        revision: (task.execution?.revision ?? 0) + 1, updatedAt: new Date().toISOString(),
        ...(patch.summary !== undefined ? { summary: boundedUtf8(patch.summary, 8 * 1024) } : {}),
        ...(patch.error !== undefined ? { error: boundedUtf8(patch.error, 4 * 1024) } : {}) };
      task.revision += 1;
      task.updatedAt = task.execution.updatedAt;
      await this.store.write(TASKS, task);
      return { task, mr };
    });
    await this.publishWorkerExecution(updated.task, updated.mr, includeFiles, changedFileIds, changedFiles);
    return updated.task.execution!;
  }

  private async publishWorkerExecution(task: StoredTask, mr: MergeRequest, includeFiles = false, changedFileIds?: string[], changedFiles?: ConversationGitSnapshot['files']): Promise<void> {
    if (!task.execution) return;
    const files = includeFiles ? await this.gitMr.files(task.projectId, mr.id) : undefined;
    this.emitState(task.sessionId, { type: 'conversation_git_state', taskId: task.id, taskRevision: task.revision,
      mrVersion: mr.version, status: mr.status, execution: task.execution, summary: task.execution?.summary,
      eventSeq: task.execution!.revision, files, changedFileIds, changedFiles, filesRevision: mr.version });
    const execution = task.execution!;
    // The API host and forked worker maintain separate in-memory projections.
    // Refresh the tiny child session summary before publishing a mailbox event;
    // otherwise the API-side cache misses the child and the parent worker never
    // receives the pause/terminal wake-up.
    if (execution.childSessionId) {
      await agentRuntimeStore.hydrateSessionSummary(execution.childSessionId, true);
    }
    if (execution.childSessionId && agentRuntimeStore.tryGetSession(execution.childSessionId)) {
      const { subagentCompletionBroker } = await import('../subagent-control-broker.js');
      await outsideExecutionContext(() => subagentCompletionBroker.publish({ taskId: task.id, parentSessionId: task.sessionId, childSessionId: execution.childSessionId!,
        status: execution.status, phase: execution.phase, joinMode: execution.joinMode, revision: execution.revision,
        eventSeq: execution.revision, epoch: String(execution.epoch), summary: execution.summary, error: execution.error,
        terminal: ['completed', 'cancelled', 'cancelled_cleanup_pending', 'failed', 'paused', 'waiting_user', 'recovery_required'].includes(execution.status) }));
    }
  }

  async workerAction(childSessionId: string, objectId: string, input: ConversationGitAction) {
    const child = agentRuntimeStore.getSession(childSessionId);
    if (!child.parentSessionId) throw notFound();
    return outsideExecutionContext(() => this.action(child.parentSessionId!, objectId, input, childSessionId));
  }

  async workerSaveFile(childSessionId: string, objectId: string, fileId: string, input: ConversationGitSave) {
    const child = agentRuntimeStore.getSession(childSessionId);
    if (!child.parentSessionId) throw notFound();
    return outsideExecutionContext(() => this.saveFile(child.parentSessionId!, objectId, fileId, input, childSessionId));
  }

  async cancelWorkerMr(sessionId: string, objectId: string) {
    const { task, mr } = await this.binding(sessionId, objectId);
    const cancelled = ['merged', 'noop', 'cancelled'].includes(mr.status) ? mr : await this.gitMr.cancel(task.projectId, mr.id, mr.version);
    if (cancelled.status === 'cancelled') {
      try { await this.gitMr.discard(task.projectId, mr.id); }
      catch (error) {
        await this.setWorkerExecution(sessionId, objectId, { status: 'cancelled_cleanup_pending', phase: 'settled',
          summary: '合并已取消，隔离候选清理未完成。继续将只重试清理。', error: error instanceof Error ? error.message : String(error) });
        throw error;
      }
    }
    await this.setWorkerExecution(sessionId, objectId, {
      status: ['merged', 'noop'].includes(cancelled.status) ? 'completed' : 'cancelled', phase: 'settled',
      summary: ['merged', 'noop'].includes(cancelled.status) ? '目标分支已更新，已按真实 Git 状态记录完成。' : '此次合并已放弃；隔离候选保留用于恢复，不再继续执行。',
    });
  }

  async startWorker(sessionId: string, objectId: string) {
    const worker = await import('./worker.js');
    return worker.startConversationMergeWorker(sessionId, objectId);
  }
  async configureChecks(sessionId: string, objectId: string, input: { requestId: string; expectedVersion: number; expectedTaskRevision: number; checks: MergeCheckConfig[] }) {
    return this.execute(sessionId, objectId, input.requestId, 'configure-checks', input, async (task, mr) => {
      this.version(task, mr, input.expectedTaskRevision, input.expectedVersion);
      if (task.execution && !['paused', 'waiting_user', 'failed', 'recovery_required'].includes(task.execution.status))
        throw new GitMrError('Stop the merge worker before changing verification.', 'WORKER_OWNS_TASK');
    }, async (task, mr) => {
      await this.gitMr.configureChecks(task.projectId, mr.id, input.expectedVersion, input.checks);
      return '已更新验证命令，可以继续智能合并。';
    });
  }

  async waitWorker(sessionId: string, snapshot: ConversationGitSnapshot, signal?: AbortSignal) {
    const worker = await import('./worker.js');
    return worker.waitForConversationMergeWorker(sessionId, snapshot, signal);
  }
  /** A control request must commit its receipt before its new worker starts mutating. */
  async awaitWorkerAdmission(objectId: string) {
    const task = await this.store.read<StoredTask>(TASKS, objectId);
    if (!task.activeRequest) return;
    const request = await this.readRequest(task.activeRequest);
    if (!request || request.status !== 'pending') return;
    const active = inFlight.get(`${this.store.directory}:${request.id}`);
    if (active && request.operation === 'resume') { await active.promise; return; }
    throw new GitMrError('A previous task command has not settled.', 'TASK_BUSY');
  }
}

export const conversationGitService = new ConversationGitService();
