import { createHash } from "node:crypto";
import { GitMrStore, gitMrStore } from "../git-mr/store.js";
import {
  git,
  inspect,
  ensureClean,
  assertBranchPolicy,
} from "../git-mr/repository.js";
import { GitMrError } from "../git-mr/errors.js";
import {
  resolveSessionRepository,
  invalidateSessionEnvironment,
} from "../agent-runtime/session-environment.js";
import {
  workspaceRootLocation,
  type ProjectWorkspaceRoot,
} from "../project-workspace.js";
import { agentRuntimeStore } from "../agent-runtime/session-store.js";
import { emitSessionLive } from "../../infrastructure/runtime/ipc/agent-session-protocol.js";
import { conversationGitService } from "../agent-runtime/conversation-git/service.js";
import type { AgentRuntimeMessage } from "../agent-runtime/contracts.js";
import type { ConversationGitSnapshot } from "../agent-runtime/conversation-git/contracts.js";
import { RemotePrProvider } from "./provider.js";
import { parseRemote, remoteChoice } from "./remote.js";
import type {
  RemotePrAction,
  RemotePrAttach,
  RemotePrCreate,
  RemotePrReference,
  RemotePrScope,
  RemotePrSnapshot,
  RemotePrTask,
  RemoteRepository,
  RemotePrDiscovery,
} from "./contracts.js";

type Repo = Awaited<ReturnType<typeof inspect>>;
interface StoredTask extends RemotePrTask {
  commonDir: string;
  rootPath: string;
  messages: AgentRuntimeMessage[];
}
type Runtime = Pick<
  typeof agentRuntimeStore,
  "getSession" | "appendMessage" | "flushSession"
>;
type Resolver = (
  sessionId: string,
  projectId: string,
  rootId?: string,
) => ProjectWorkspaceRoot;
interface Receipt {
  id: string;
  argsHash: string;
  state: "pending" | "done";
  objectId?: string;
}
const hash = (s: string) => createHash("sha256").update(s).digest("hex");
const boundedSha = (value: string) => /^[a-f0-9]{40,64}$/.test(value);
export class RemotePrService {
  constructor(
    readonly provider = new RemotePrProvider(),
    readonly store: GitMrStore = gitMrStore,
    readonly runtime: Runtime = agentRuntimeStore,
    readonly resolveRoot: Resolver = (s, p, r) =>
      resolveSessionRepository(s, p, r, true),
    readonly localTasks = conversationGitService,
    readonly runGit: typeof git = git,
  ) {}
  private async scope(sessionId: string, rootId?: string) {
    const session = this.runtime.getSession(sessionId);
    const root = this.resolveRoot(sessionId, session.projectId, rootId);
    const repo = await inspect(workspaceRootLocation(root));
    return { session, root, repo };
  }
  private async remote(
    repo: Repo,
    input: RemotePrScope,
  ): Promise<RemoteRepository> {
    const names = (await this.runGit(repo, ["remote"])).stdout
      .trim()
      .split("\n");
    if (!names.includes(input.remote))
      throw new GitMrError(
        "请选择已配置的 Git remote。",
        "PR_REMOTE_MISSING",
        400,
      );
    const urls = (
      await this.runGit(repo, ["remote", "get-url", "--all", input.remote])
    ).stdout
      .trim()
      .split("\n");
    if (urls.length !== 1)
      throw new GitMrError(
        "该 remote 有多个地址，请为 PR 使用单一仓库 remote。",
        "PR_REMOTE_AMBIGUOUS",
        409,
      );
    return parseRemote(input.remote, urls[0], input.provider);
  }
  private async local(repo: Repo) {
    return {
      branch: (
        await this.runGit(repo, ["branch", "--show-current"])
      ).stdout.trim(),
      headSha: (await this.runGit(repo, ["rev-parse", "HEAD"])).stdout.trim(),
      dirty: Boolean(
        (await this.runGit(repo, ["status", "--porcelain=v1", "-z"])).stdout,
      ),
    };
  }
  async discover(
    sessionId: string,
    rootId?: string,
  ): Promise<RemotePrDiscovery> {
    const { root, repo } = await this.scope(sessionId, rootId);
    const names = (await this.runGit(repo, ["remote"])).stdout
      .trim()
      .split("\n")
      .filter(Boolean);
    const remotes = await Promise.all(
      names.map(async (name) =>
        remoteChoice(
          name,
          (await this.runGit(repo, ["remote", "get-url", name])).stdout.trim(),
        ),
      ),
    );
    return {
      rootId: root.id,
      ...(await this.local(repo)),
      remotes,
      branches: (
        await this.runGit(repo, [
          "for-each-ref",
          "--format=%(refname:short)",
          "refs/heads",
        ])
      ).stdout
        .trim()
        .split("\n")
        .filter(Boolean),
    };
  }
  async list(sessionId: string, input: RemotePrScope, page = 1) {
    const { repo } = await this.scope(sessionId, input.rootId);
    return this.provider.list(await this.remote(repo, input), page);
  }
  private async binding(sessionId: string, objectId: string) {
    const task = await this.store.read<StoredTask>("remote-pr-tasks", objectId);
    const scope = await this.scope(sessionId, task.rootId);
    if (
      task.sessionId !== sessionId ||
      task.projectId !== scope.session.projectId
    )
      throw new GitMrError("远程任务不属于当前会话。", "NOT_FOUND", 404);
    if (
      task.commonDir !== scope.repo.commonDir ||
      task.rootPath !== scope.repo.repository
    )
      throw new GitMrError(
        "工作区绑定已变化，请重新打开 PR。",
        "PR_SCOPE_CHANGED",
        409,
      );
    const repository = await this.remote(scope.repo, task.repository);
    if (
      repository.host !== task.repository.host ||
      repository.path !== task.repository.path ||
      repository.provider !== task.repository.provider
    )
      throw new GitMrError(
        "Remote 地址已变化，请重新打开 PR。",
        "PR_SCOPE_CHANGED",
        409,
      );
    return { task, ...scope };
  }
  private reference(task: RemotePrTask, title: string): RemotePrReference {
    return {
      schema: "synax.git-pr",
      schemaVersion: 1,
      objectId: task.id,
      sessionId: task.sessionId,
      projectId: task.projectId,
      rootId: task.rootId,
      title,
    };
  }
  async get(sessionId: string, objectId: string): Promise<RemotePrSnapshot> {
    const { task, repo } = await this.binding(sessionId, objectId);
    const [pr, local] = await Promise.all([
      this.provider.get(task.repository, task.number),
      this.local(repo),
    ]);
    const { commonDir: _common, rootPath: _path, messages, ...visible } = task;
    return {
      task: visible,
      reference: this.reference(task, pr.title),
      pr,
      local,
      messages: [messages[0], ...messages.slice(1).slice(-16)],
      ...(task.resolution
        ? {
            resolutionReference: (
              await this.localTasks.get(sessionId, task.resolution.objectId)
            ).reference,
          }
        : {}),
    };
  }
  private async publish(task: StoredTask) {
    const changed = [
      task.messages[0],
      ...task.messages.slice(-1).filter((m) => m.id !== task.messageId),
    ];
    for (const message of changed) this.runtime.appendMessage(message);
    await this.runtime.flushSession(task.sessionId);
    emitSessionLive(task.sessionId, {
      type: "conversation_git_messages",
      messages: changed,
    });
  }
  private async saveTask(
    sessionId: string,
    repository: RemoteRepository,
    number: number,
    rootId: string,
  ) {
    const identity = hash(
      `${sessionId}:${rootId}:${repository.host}:${repository.path}:${number}`,
    );
    return this.store.exclusive(`remote-pr-bind:${identity}`, () =>
      this.saveTaskLocked(sessionId, repository, number, rootId),
    );
  }
  private async saveTaskLocked(
    sessionId: string,
    repository: RemoteRepository,
    number: number,
    rootId: string,
  ) {
    const { session, repo } = await this.scope(sessionId, rootId);
    const id = hash(
      `${sessionId}:${rootId}:${repository.host}:${repository.path}:${number}`,
    );
    const previous = await this.store
      .read<StoredTask>("remote-pr-tasks", id)
      .catch((e) => {
        if (e.code === "NOT_FOUND") return null;
        throw e;
      });
    if (previous) {
      await this.publish(previous);
      return this.get(sessionId, id);
    }
    const pr = await this.provider.get(repository, number);
    const now = new Date().toISOString();
    const task: StoredTask = {
      id,
      sessionId,
      projectId: session.projectId,
      rootId,
      repository,
      number,
      revision: 1,
      messageId: `pr-task-${id}`,
      createdAt: now,
      updatedAt: now,
      commonDir: repo.commonDir,
      rootPath: repo.repository,
      messages: [],
    };
    const reference = this.reference(task, pr.title);
    task.messages.push({
      id: task.messageId,
      sessionId,
      runId: null,
      stepId: null,
      role: "assistant",
      content: `远程 ${repository.provider === "github" ? "PR" : "MR"} #${number}: ${pr.title}。objectId: ${id}`,
      metadata: {
        source: "git_merge_task",
        gitMergeTask: reference,
        gitMergeState: { status: pr.state, revision: 1 },
      },
      createdAt: now,
    });
    await this.store.write("remote-pr-tasks", task);
    await this.publish(task);
    return this.get(sessionId, id);
  }
  private async idempotent(
    sessionId: string,
    requestId: string,
    args: unknown,
    run: () => Promise<RemotePrSnapshot>,
    recover?: () => Promise<RemotePrSnapshot>,
  ) {
    const id = hash(`${sessionId}:${requestId}`);
    const argsHash = hash(JSON.stringify(args));
    return this.store.exclusive(`remote-pr-request:${id}`, async () => {
      const receipt = await this.store
        .read<Receipt>("remote-pr-requests", id)
        .catch((e) => {
          if (e.code === "NOT_FOUND") return null;
          throw e;
        });
      if (receipt && receipt.argsHash !== argsHash)
        throw new GitMrError(
          "该请求编号已用于其他操作。",
          "IDEMPOTENCY_CONFLICT",
          409,
        );
      if (receipt?.state === "done" && receipt.objectId)
        return this.get(sessionId, receipt.objectId);
      if (receipt?.state === "pending" && !recover)
        throw new GitMrError(
          "上次远程请求结果未确认。请刷新远程状态后再决定是否重试。",
          "PR_UNCERTAIN",
          409,
        );
      await this.store.write("remote-pr-requests", {
        id,
        argsHash,
        state: "pending",
      } satisfies Receipt);
      const result = receipt ? await recover!() : await run();
      await this.store.write("remote-pr-requests", {
        id,
        argsHash,
        state: "done",
        objectId: result.task.id,
      } satisfies Receipt);
      return result;
    });
  }
  async attach(sessionId: string, input: RemotePrAttach) {
    const { repo, root } = await this.scope(sessionId, input.rootId);
    const repository = await this.remote(repo, input);
    const run = () =>
      this.saveTask(sessionId, repository, input.number, root.id);
    return this.idempotent(
      sessionId,
      input.requestId,
      { operation: "attach", ...input },
      run,
      run,
    );
  }
  async create(sessionId: string, input: RemotePrCreate) {
    const { repo, root } = await this.scope(sessionId, input.rootId);
    const repository = await this.remote(repo, input);
    assertBranchPolicy(input.base, [input.head]);
    await this.runGit(repo, ["check-ref-format", `refs/heads/${input.head}`]);
    await this.runGit(repo, ["check-ref-format", `refs/heads/${input.base}`]);
    const run = async () => {
      const pr = await this.provider.create(repository, input);
      return this.saveTask(sessionId, repository, pr.number, root.id);
    };
    // Provider creation discovers an existing head/base request before POST, including after transport loss.
    return this.idempotent(
      sessionId,
      input.requestId,
      { operation: "create", ...input },
      run,
      run,
    );
  }
  async push(
    sessionId: string,
    input: RemotePrScope & { expectedLocalHead: string; branch: string },
  ) {
    const { repo, root, session } = await this.scope(sessionId, input.rootId);
    const repository = await this.remote(repo, input);
    if (session.activeRunId)
      throw new GitMrError(
        "Agent 正在使用工作区，请等待当前执行结束。",
        "WORKSPACE_BUSY",
        409,
      );
    return this.store.exclusive(repo.commonDir, async () => {
      const local = await this.local(repo);
      if (
        local.branch !== input.branch ||
        local.headSha !== input.expectedLocalHead
      )
        throw new GitMrError(
          "本地分支发生变化，请刷新后再推送。",
          "STALE_VERSION",
          409,
        );
      if (!local.branch || local.dirty)
        throw new GitMrError(
          "请先提交或保存工作区改动，再推送分支。",
          "DIRTY_WORKTREE",
          409,
        );
      // Push URL must match the chosen PR repository; never honor a hidden second destination.
      const pushUrls = (
        await this.runGit(repo, [
          "remote",
          "get-url",
          "--push",
          "--all",
          input.remote,
        ])
      ).stdout
        .trim()
        .split("\n");
      if (
        pushUrls.length !== 1 ||
        JSON.stringify(
          parseRemote(input.remote, pushUrls[0], repository.provider),
        ) !== JSON.stringify(repository)
      )
        throw new GitMrError(
          "推送地址与 PR 仓库不同，请检查 remote 配置。",
          "PR_PUSH_REMOTE_MISMATCH",
          409,
        );
      await this.runGit(repo, [
        "push",
        "--",
        input.remote,
        `${input.expectedLocalHead}:refs/heads/${local.branch}`,
      ]);
      invalidateSessionEnvironment(sessionId);
      return this.discover(sessionId, root.id);
    });
  }
  async action(sessionId: string, objectId: string, input: RemotePrAction) {
    await this.binding(sessionId, objectId);
    const recover = async () => {
      const snapshot = await this.get(sessionId, objectId);
      if (input.action === "merge" && snapshot.pr.state === "merged")
        return snapshot;
      throw new GitMrError(
        "上次远程操作结果未确认；已刷新状态，请核对后使用新操作。",
        "PR_UNCERTAIN",
        409,
      );
    };
    return this.idempotent(
      sessionId,
      input.requestId,
      { objectId, ...input },
      () =>
        this.store.exclusive(`remote-pr-task:${objectId}`, async () => {
          const { task, repo } = await this.binding(sessionId, objectId);
          const pr = await this.provider.get(task.repository, task.number);
          if (
            task.revision !== input.expectedRevision ||
            pr.headSha !== input.expectedHeadSha ||
            pr.baseSha !== input.expectedBaseSha
          )
            throw new GitMrError(
              "PR 或任务版本已更新，请刷新后再操作。",
              "STALE_VERSION",
              409,
            );
          if (!boundedSha(pr.headSha) || !boundedSha(pr.baseSha))
            throw new GitMrError(
              "远程分支快照不可用，请刷新。",
              "PR_INVALID_RESPONSE",
              409,
            );
          if (
            input.action !== "sync_local" &&
            (pr.state !== "open" || pr.draft)
          )
            throw new GitMrError(
              "仅已准备好的开放请求可执行此操作。",
              "PR_NOT_READY",
              409,
            );
          let summary = "";
          if (input.action === "merge") {
            if (
              pr.mergeable !== true ||
              pr.checksError ||
              pr.checks.some((check) => check.status !== "passed")
            )
              throw new GitMrError(
                "远程合并条件尚未满足，请检查冲突、审核和 CI。",
                "PR_CHECKS_PENDING",
                409,
              );
            await this.provider.merge(
              task.repository,
              pr,
              input.mergeMethod ?? "merge",
            );
            summary = `已向 ${task.repository.provider} 确认合并 #${pr.number}；以远程状态为准。`;
          } else if (input.action === "update_branch") {
            if (!pr.sameRepository)
              throw new GitMrError(
                "Fork 请求请在来源仓库同步分支。",
                "PR_FORK_SYNC",
                409,
              );
            assertBranchPolicy(pr.head, [pr.base]);
            await this.provider.updateBranch(task.repository, pr);
            summary =
              task.repository.provider === "github"
                ? "已请求将目标分支同步到 PR 分支。"
                : "已请求 GitLab rebase，正在等待平台更新。";
          } else if (input.action === "sync_local") {
            if (this.runtime.getSession(sessionId).activeRunId)
              throw new GitMrError(
                "Agent 正在使用工作区，请等待当前执行结束。",
                "WORKSPACE_BUSY",
                409,
              );
            if (!pr.sameRepository)
              throw new GitMrError(
                "Fork 请求请切换到来源仓库后同步。",
                "PR_FORK_SYNC",
                409,
              );
            await this.store.exclusive(repo.commonDir, async () => {
              const local = await this.local(repo);
              const syncedBranch = local.branch;
              const expectedSha = syncedBranch === pr.base ? pr.baseSha : pr.headSha;
              if (![pr.head, pr.base].includes(local.branch))
                throw new GitMrError(
                  `请先切换到本地 ${pr.head} 或 ${pr.base} 分支。`,
                  "PR_BRANCH_MISMATCH",
                  409,
                );
              await ensureClean(repo, repo.repository);
              await this.runGit(repo, [
                "fetch",
                "--no-tags",
                "--",
                task.repository.remote,
                `refs/heads/${syncedBranch}`,
              ]);
              const fetched = (
                await this.runGit(repo, ["rev-parse", "FETCH_HEAD"])
              ).stdout.trim();
              if (fetched !== expectedSha)
                throw new GitMrError(
                  "远程分支在同步期间发生变化，请刷新。",
                  "STALE_VERSION",
                  409,
                );
              await this.runGit(repo, ["merge", "--ff-only", expectedSha]);
              summary = `已快进同步本地 ${syncedBranch}，保留本地提交历史。`;
            });
            invalidateSessionEnvironment(sessionId);
          } else if (input.action === "resolve_conflicts") {
            if (!pr.sameRepository)
              throw new GitMrError(
                "Fork 冲突请在来源仓库解决。",
                "PR_FORK_SYNC",
                409,
              );
            assertBranchPolicy(pr.head, [pr.base]);
            const suffix =
              objectId.slice(0, 12) + "-" + hash(input.requestId).slice(0, 8);
            const headBranch = `synax-pr/${suffix}/head`,
              baseBranch = `synax-pr/${suffix}/base`;
            await this.store.exclusive(repo.commonDir, async () => {
              for (const [branch, sha, name] of [
                [pr.head, pr.headSha, headBranch],
                [pr.base, pr.baseSha, baseBranch],
              ]) {
                await this.runGit(repo, [
                  "fetch",
                  "--no-tags",
                  "--",
                  task.repository.remote,
                  `refs/heads/${branch}`,
                ]);
                if (
                  (
                    await this.runGit(repo, ["rev-parse", "FETCH_HEAD"])
                  ).stdout.trim() !== sha
                )
                  throw new GitMrError(
                    "远程分支已更新，请刷新。",
                    "STALE_VERSION",
                    409,
                  );
                await this.runGit(repo, ["branch", name, sha]);
              }
            });
            const localTask = await this.localTasks.create(sessionId, {
              requestId: `pr-${input.requestId}`,
              rootId: task.rootId,
              title: `解决 ${task.repository.provider === "github" ? "PR" : "MR"} #${pr.number} 冲突`,
              target: headBranch,
              sources: [baseBranch],
              strategy: "merge_commit",
              checks: [],
              allowCheckedOutTarget: false,
            });
            await this.localTasks.action(sessionId, localTask.task.id, {
              requestId: `pr-analyze-${input.requestId}`,
              action: "prepare",
              expectedVersion: localTask.mr.version,
              expectedTaskRevision: localTask.task.revision,
            });
            task.resolution = {
              objectId: localTask.task.id,
              headBranch,
              baseBranch,
              headSha: pr.headSha,
              baseSha: pr.baseSha,
            };
            summary =
              "已创建隔离冲突任务。解决并确认本地候选后，回到 PR 卡片推送结果。";
          } else if (input.action === "publish_resolution") {
            if (
              !task.resolution ||
              pr.headSha !== task.resolution.headSha ||
              pr.baseSha !== task.resolution.baseSha
            )
              throw new GitMrError(
                "解决方案基线已变化，请重新分析。",
                "STALE_VERSION",
                409,
              );
            const resolved = await this.localTasks.get(
              sessionId,
              task.resolution.objectId,
            );
            if (
              !["merged", "noop"].includes(resolved.mr.status) ||
              !resolved.mr.candidateOid
            )
              throw new GitMrError(
                "请先在冲突任务中确认本地候选结果。",
                "PR_RESOLUTION_PENDING",
                409,
              );
            const pushUrls = (
              await this.runGit(repo, [
                "remote",
                "get-url",
                "--push",
                "--all",
                task.repository.remote,
              ])
            ).stdout
              .trim()
              .split("\n");
            if (
              pushUrls.length !== 1 ||
              JSON.stringify(
                parseRemote(
                  task.repository.remote,
                  pushUrls[0],
                  task.repository.provider,
                ),
              ) !== JSON.stringify(task.repository)
            )
              throw new GitMrError(
                "推送地址与 PR 仓库不同，请检查 remote 配置。",
                "PR_PUSH_REMOTE_MISMATCH",
                409,
              );
            await this.runGit(repo, [
              "push",
              "--",
              task.repository.remote,
              `${resolved.mr.candidateOid}:refs/heads/${pr.head}`,
            ]);
            summary = "已推送解决结果到 PR 来源分支，远程 CI 将重新运行。";
          }
          task.revision++;
          task.updatedAt = new Date().toISOString();
          const after = await this.provider.get(task.repository, task.number);
          const reference = this.reference(task, after.title);
          task.messages[0] = {
            ...task.messages[0],
            metadata: {
              ...task.messages[0].metadata,
              gitMergeTask: reference,
              gitMergeState: { status: after.state, revision: task.revision },
            },
          };
          task.messages.push({
            id: `pr-receipt-${hash(input.requestId)}`,
            sessionId,
            runId: null,
            stepId: null,
            role: "assistant",
            content: summary,
            metadata: {
              source: "git_merge_receipt",
              gitMergeTask: reference,
              operation: input.action,
              status: "succeeded",
            },
            createdAt: task.updatedAt,
          });
          await this.store.write("remote-pr-tasks", task);
          await this.publish(task);
          return this.get(sessionId, objectId);
        }),
      recover,
    );
  }
}
export const remotePrService = new RemotePrService();
