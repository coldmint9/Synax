import { createHash, randomUUID } from 'node:crypto';
import { GitMrService, gitMrService } from '../../git-mr/service.js';
import { GitMrStore, gitMrStore } from '../../git-mr/store.js';
import { GitMrError } from '../../git-mr/errors.js';
import { branchOid, git, inspect } from '../../git-mr/repository.js';
import type { MergeRequest, MergeRequestInput, MergeProposal } from '../../git-mr/contracts.js';
import { workspaceRootLocation, type ProjectWorkspaceRoot } from '../../project-workspace.js';
import { canonicalizeWorkspaceLocation, type WorkspaceLocation } from '../../workspace-location.js';
import { resolveSessionWorkspaceRoots } from '../tools/workspace.js';
import { agentRuntimeStore } from '../session-store.js';
import { emitSessionLive } from '../../../infrastructure/runtime/ipc/agent-session-protocol.js';
import type { AgentRuntimeMessage } from '../contracts.js';
import type {
  ConversationGitAction, ConversationGitApplyProposal, ConversationGitCommit,
  ConversationGitCreate, ConversationGitReference, ConversationGitSave,
  ConversationGitSnapshot, ConversationGitTask,
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
}
interface StoredTask extends ConversationGitTask {
  rootLocation: WorkspaceLocation;
  repository: string;
  commonDir: string;
  messages: AgentRuntimeMessage[];
  activeRequest?: string;
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
}
type OriginContext = { runId?: string | null; stepId?: string | null; toolCallId?: string | null };
const TASKS = 'conversation-tasks';
const REQUESTS = 'conversation-requests';
const inFlight = new Map<string, { hash: string; promise: Promise<ConversationGitSnapshot> }>();
const shortLocks = new Map<string, Promise<unknown>>();
const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const canonical = (value: unknown): string => {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(',')}}`;
};
const notFound = () => new GitMrError('Conversation merge task not found.', 'NOT_FOUND', 404);
const requestError = (error: unknown) => error instanceof GitMrError
  ? { message: error.message, code: error.code, status: error.status }
  : { message: error instanceof Error ? error.message : String(error), code: 'CONVERSATION_GIT_ERROR', status: 500 };
const taskView = ({ rootLocation: _root, repository: _repo, commonDir: _common, messages: _messages, activeRequest: _request, ...task }: StoredTask): ConversationGitTask => task;
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
  constructor(options: ConversationGitServiceOptions = {}) {
    this.gitMr = options.gitMr ?? gitMrService;
    this.store = options.store ?? options.gitMr?.store ?? gitMrStore;
    this.runtime = options.runtimeStore ?? agentRuntimeStore;
    this.roots = options.resolveRoots ?? resolveSessionWorkspaceRoots;
    this.emitMessages = options.emitMessages ?? ((sessionId, messages) => emitSessionLive(sessionId, { type: 'conversation_git_messages', messages }));
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
    const { task, mr } = await this.binding(sessionId, objectId);
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
    return { task: taskView(task), reference: this.reference(task, mr), mr, files,
      proposals: latestProposals(proposals), commits, ...stale, messages: recentMessages(task) };
  }

  async list(sessionId: string): Promise<ConversationGitSnapshot[]> {
    const session = this.runtime.getSession(sessionId);
    const tasks = (await this.store.list<StoredTask>(TASKS, session.projectId))
      .filter(task => task.sessionId === sessionId).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return Promise.all(tasks.map(task => this.get(sessionId, task.id)));
  }

  async file(sessionId: string, objectId: string, fileId: string) {
    const { task, mr } = await this.binding(sessionId, objectId);
    return this.gitMr.file(task.projectId, mr.id, fileId);
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
    const receiptId = `git-receipt-${record.id}`;
    if (!task.messages.some(item => item.id === receiptId)) {
      task.revision += 1;
      task.updatedAt = new Date().toISOString();
      if (task.activeRequest === record.id) delete task.activeRequest;
      const reference = this.reference(task, mr);
      task.messages[0] = { ...task.messages[0], metadata: { ...task.messages[0].metadata,
        gitMergeTask: reference, gitMergeState: { status: mr.status, revision: task.revision, mrVersion: mr.version } } };
      task.messages.push({ id: receiptId, sessionId: task.sessionId, runId: null, stepId: null,
        role: 'assistant', content: message ?? (error ? `合并任务操作未完成：${requestError(error).message}` : `合并任务已更新：${mr.status}。`),
        metadata: { source: 'git_merge_receipt', gitMergeTask: reference, operation: record.operation, requestId: record.id,
          status: error ? 'failed' : 'succeeded', mrStatus: mr.status }, createdAt: task.updatedAt });
      await this.store.write(TASKS, task);
    }
    record.status = error ? 'failed' : 'succeeded';
    record.error = error ? requestError(error) : undefined;
    await this.store.write(REQUESTS, record);
    // The Git outcome is durable before cross-store delivery. A retry may
    // re-upsert these stable message IDs, but must never repeat the Git write.
    await this.persistMessages(task, `git-receipt-${record.id}`);
    record.messagesDelivered = true;
    await this.store.write(REQUESTS, record);
  }

  private async execute(
    sessionId: string, objectId: string, requestId: string, operation: string, args: unknown,
    validate: (task: StoredTask, mr: MergeRequest) => Promise<void>,
    work: (task: StoredTask, mr: MergeRequest) => Promise<string | void>,
  ): Promise<ConversationGitSnapshot> {
    // Scope validation precedes even a cached request lookup.
    await this.binding(sessionId, objectId);
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
            await this.persistMessages(task, `git-receipt-${prior.id}`);
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
          const canStop = operation === 'cancel' && active?.operation === 'checks';
          if (active?.status === 'pending' && !canStop) {
            let alive = true;
            try { process.kill(active.pid, 0); } catch (error) { alive = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
            if (alive) throw new GitMrError('A task operation is already running.', 'TASK_BUSY');
            if (!['resume', 'replan', 'cancel'].includes(operation))
              throw new GitMrError('Resume or replan the interrupted operation first.', 'OPERATION_INTERRUPTED');
          }
        }
        await validate(task, mr);
        reserved = { id, sessionId, projectId: task.projectId, objectId, operation, argsHash: hash,
          status: 'pending', pid: process.pid, createdAt: new Date().toISOString() };
        await this.store.write(REQUESTS, reserved);
        if (!(operation === 'cancel' && task.activeRequest)) task.activeRequest = id;
        await this.store.write(TASKS, task);
        target = { task, mr };
      }));
      if (cached) return this.get(sessionId, objectId);
      let error: unknown;
      let message: string | void;
      try { message = await work(target!.task, target!.mr); }
      catch (failure) { error = failure; }
      reserved!.outcome = { message: message! || undefined, error: error ? requestError(error) : undefined };
      await this.store.write(REQUESTS, reserved!);
      await this.finish(reserved!, error, message!);
      if (error) throw error;
      return this.get(sessionId, objectId);
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

  async action(sessionId: string, objectId: string, input: ConversationGitAction) {
    return this.execute(sessionId, objectId, input.requestId, input.action, input, async (task, mr) => {
      this.version(task, mr, input.expectedTaskRevision, input.expectedVersion);
      if (!['cancel', 'resume', 'replan'].includes(input.action)) {
        const freshness = await this.stale(mr);
        if (freshness.stale) throw new GitMrError(freshness.staleReason!, 'STALE_PLAN');
      }
      if (input.action === 'replan' && ['preparing', 'checking', 'applying', 'merged', 'noop'].includes(mr.status))
        throw new GitMrError('Finish or stop the current operation before replanning.', 'INVALID_STATE');
    }, async (task, mr) => {
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
      const methods = { prepare: 'prepare', continue: 'continue', checks: 'checks', finalize: 'finalize', cancel: 'cancel', resume: 'resume' } as const;
      const method = methods[input.action];
      if (!method) throw new GitMrError('Unknown merge action.', 'INVALID_ACTION', 400);
      let outcome: MergeRequest;
      try { outcome = await this.gitMr[method](task.projectId, mr.id, input.expectedVersion); }
      catch (error) {
        if (input.action === 'cancel' && error instanceof GitMrError && error.code === 'STOPPING')
          return '已请求停止验证；等待进程退出后可取消任务，草稿将保留。';
        throw error;
      }
      if (input.action === 'cancel' && outcome.status === 'merged')
        return `目标分支 ${mr.target} 已包含候选结果，任务已核实为合并完成。`;
      const receipts = { prepare: '已准备隔离合并工作区。', continue: '已保存解决结果并继续合并。', checks: '验证执行已结束，请查看检查结果。', finalize: `合并完成，目标分支 ${mr.target} 已更新。`, cancel: '合并任务已取消，隔离工作区和草稿已保留。', resume: '已恢复任务，请查看当前 Git 状态。' };
      return receipts[method];
    });
  }

  async saveFile(sessionId: string, objectId: string, fileId: string, input: ConversationGitSave) {
    return this.execute(sessionId, objectId, input.requestId, 'save-file', { fileId, ...input }, async (task, mr) => {
      this.version(task, mr, input.expectedTaskRevision, input.expectedVersion);
      const freshness = await this.stale(mr);
      if (freshness.stale) throw new GitMrError(freshness.staleReason!, 'STALE_PLAN');
      if (mr.status !== 'conflicted') throw new GitMrError('Only active conflicts can be edited.', 'INVALID_STATE');
      const file = await this.gitMr.file(task.projectId, mr.id, fileId);
      if (file.revision !== input.expectedRevision) throw new GitMrError('Conflict draft changed; reload first.', 'STALE_DRAFT');
    }, async (task, mr) => {
      const saved = await this.gitMr.saveFile(task.projectId, mr.id, fileId, input, input.expectedVersion);
      return `${input.resolve ? '已确认解决' : '已保存草稿'}：${saved.path}。`;
    });
  }

  async applyProposal(sessionId: string, objectId: string, input: ConversationGitApplyProposal) {
    return this.execute(sessionId, objectId, input.requestId, 'apply-proposal', input, async (task, mr) => {
      this.version(task, mr, input.expectedTaskRevision, input.expectedVersion);
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
}

export const conversationGitService = new ConversationGitService();
