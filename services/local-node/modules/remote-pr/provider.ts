import { runCommand } from "../agent-runtime/tools/exec-async.js";
import { cleanEnvironment } from "../git-mr/repository.js";
import { GitMrError } from "../git-mr/errors.js";
import { safeRemoteUrl } from "./remote.js";
import type {
  RemoteRepository,
  RemotePullRequest,
  RemotePrCheck,
  RemotePrCreate,
} from "./contracts.js";

type Json = Record<string, any>;
export type PrApi = (
  repository: RemoteRepository,
  method: string,
  endpoint: string,
  body?: unknown,
) => Promise<any>;
export const cliPrApi: PrApi = async (repo, method, endpoint, body) => {
  const executable = repo.provider === "github" ? "gh" : "glab";
  const result = await runCommand(
    executable,
    [
      "api",
      "--hostname",
      repo.host,
      "--method",
      method,
      endpoint,
      ...(body === undefined ? [] : ["--input", "-"]),
    ],
    {
      cwd: process.cwd(),
      timeoutMs: 60000,
      maxBufferBytes: 4 * 1024 * 1024,
      stdin: body === undefined ? undefined : JSON.stringify(body),
      inheritEnv: false,
      env: {
        ...cleanEnvironment(),
        ...(process.env.XDG_CONFIG_HOME
          ? { XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME }
          : {}),
        ...(process.env.GH_CONFIG_DIR
          ? { GH_CONFIG_DIR: process.env.GH_CONFIG_DIR }
          : {}),
        ...(process.env.GLAB_CONFIG_DIR
          ? { GLAB_CONFIG_DIR: process.env.GLAB_CONFIG_DIR }
          : {}),
        GH_PROMPT_DISABLED: "1",
        GIT_TERMINAL_PROMPT: "0",
        NO_COLOR: "1",
      },
    },
  );
  if (result.error?.message.includes("ENOENT"))
    throw new GitMrError(
      `尚未安装 ${executable}。请安装官方 CLI，并运行 ${executable} auth login --hostname ${repo.host}。`,
      "PR_CLI_MISSING",
      422,
    );
  if (
    result.status !== 0 ||
    result.timedOut ||
    result.error ||
    result.stdoutTruncated
  ) {
    const auth = /401|403|auth login|not logged|authentication|token/i.test(
      result.stderr,
    );
    const stale = /409|422|sha.*match/i.test(result.stderr);
    throw new GitMrError(
      auth
        ? `请检查 ${executable} 在 ${repo.host} 的登录状态与仓库权限。`
        : stale
          ? "远程状态发生变化或请求被平台拒绝，请刷新后检查分支和合并条件。"
          : `远程请求未完成，请检查 ${executable} 连接和平台状态后刷新重试。`,
      auth
        ? "PR_AUTH_REQUIRED"
        : stale
          ? "PR_REMOTE_CONFLICT"
          : "PR_REQUEST_FAILED",
      auth ? 403 : stale ? 409 : 502,
    );
  }
  try {
    return result.stdout.trim() ? JSON.parse(result.stdout) : {};
  } catch {
    throw new GitMrError(
      "远程平台返回了无法识别的响应。",
      "PR_INVALID_RESPONSE",
      502,
    );
  }
};
const status = (value: string): RemotePrCheck["status"] =>
  ["success", "passed", "neutral", "skipped"].includes(value)
    ? "passed"
    : [
          "failed",
          "failure",
          "error",
          "cancelled",
          "canceled",
          "timed_out",
          "action_required",
        ].includes(value)
      ? "failed"
      : [
            "pending",
            "running",
            "queued",
            "in_progress",
            "created",
            "waiting_for_resource",
            "preparing",
            "manual",
          ].includes(value)
        ? "pending"
        : "unknown";
export class RemotePrProvider {
  constructor(readonly api: PrApi = cliPrApi) {}
  private prefix(repo: RemoteRepository) {
    return repo.provider === "github"
      ? `repos/${repo.path}`
      : `projects/${encodeURIComponent(repo.path)}`;
  }
  private listPath(repo: RemoteRepository) {
    return `${this.prefix(repo)}/${repo.provider === "github" ? "pulls" : "merge_requests"}`;
  }
  private normalize(repo: RemoteRepository, row: Json): RemotePullRequest {
    const github = repo.provider === "github";
    const number = Number(github ? row.number : row.iid);
    if (!Number.isSafeInteger(number) || number < 1)
      throw new GitMrError("远程请求编号无效。", "PR_INVALID_RESPONSE", 502);
    return {
      number,
      title: String(row.title ?? ""),
      body: String((github ? row.body : row.description) ?? ""),
      url: safeRemoteUrl(github ? row.html_url : row.web_url, repo),
      state:
        row.merged || row.merged_at || row.state === "merged"
          ? "merged"
          : ["open", "opened"].includes(row.state)
            ? "open"
            : "closed",
      draft: Boolean(row.draft || row.work_in_progress),
      head: String(github ? row.head?.ref : row.source_branch),
      base: String(github ? row.base?.ref : row.target_branch),
      headSha: String(
        (github ? row.head?.sha : (row.sha ?? row.diff_refs?.head_sha)) ?? "",
      ),
      baseSha: String(
        (github ? row.base?.sha : row.diff_refs?.start_sha) ?? "",
      ),
      mergeable: github
        ? typeof row.mergeable === "boolean"
          ? row.mergeable
          : null
        : row.has_conflicts
          ? false
          : row.detailed_merge_status === "mergeable"
            ? true
            : null,
      mergeStatus: String(
        (github
          ? row.mergeable_state
          : row.rebase_in_progress
            ? "rebasing"
            : (row.detailed_merge_status ?? row.merge_status)) ?? "unknown",
      ),
      author: String((github ? row.user?.login : row.author?.username) ?? ""),
      checks: [],
      sameRepository: github
        ? row.head?.repo?.full_name === row.base?.repo?.full_name
        : row.source_project_id === row.target_project_id,
      updatedAt: String(row.updated_at ?? ""),
    };
  }
  async list(
    repo: RemoteRepository,
    page = 1,
  ): Promise<{ items: RemotePullRequest[]; hasMore: boolean }> {
    const state = repo.provider === "github" ? "open" : "opened";
    const rows = await this.api(
      repo,
      "GET",
      `${this.listPath(repo)}?state=${state}&per_page=30&page=${page}&${repo.provider === "github" ? "sort=updated&direction=desc" : "order_by=updated_at&sort=desc"}`,
    );
    if (!Array.isArray(rows))
      throw new GitMrError(
        "远程请求列表格式无效。",
        "PR_INVALID_RESPONSE",
        502,
      );
    return {
      items: rows.map((row) => this.normalize(repo, row)),
      hasMore: rows.length === 30,
    };
  }
  async get(
    repo: RemoteRepository,
    number: number,
  ): Promise<RemotePullRequest> {
    const row = await this.api(
      repo,
      "GET",
      `${this.listPath(repo)}/${number}${repo.provider === "gitlab" ? "?include_rebase_in_progress=true" : ""}`,
    );
    const pr = this.normalize(repo, row);
    if (repo.provider === "gitlab") {
      const target = await this.api(
        repo,
        "GET",
        `${this.prefix(repo)}/repository/branches/${encodeURIComponent(pr.base)}`,
      );
      if (typeof target.commit?.id !== "string")
        throw new GitMrError(
          "无法读取目标分支版本，请刷新。",
          "PR_INVALID_RESPONSE",
          502,
        );
      pr.baseSha = target.commit.id;
    }
    try {
      if (repo.provider === "github") {
        const [checks, combined] = await Promise.all([
          this.api(
            repo,
            "GET",
            `${this.prefix(repo)}/commits/${pr.headSha}/check-runs?per_page=100&filter=latest`,
          ),
          this.api(
            repo,
            "GET",
            `${this.prefix(repo)}/commits/${pr.headSha}/status?per_page=100`,
          ),
        ]);
        if (
          (checks.total_count ?? 0) > (checks.check_runs?.length ?? 0) ||
          (combined.total_count ?? 0) > (combined.statuses?.length ?? 0)
        )
          pr.checksError = "检查结果超过当前显示范围，请在平台核对完整结果。";
        pr.checks = [
          ...(checks.check_runs ?? []).map((check: Json) => ({
            name: String(check.name),
            status: status(
              check.status === "completed" ? check.conclusion : check.status,
            ),
            url: safeRemoteUrl(check.html_url, repo),
          })),
          ...(combined.statuses ?? []).map((check: Json) => ({
            name: String(check.context),
            status: status(check.state),
            url: safeRemoteUrl(check.target_url, repo),
          })),
        ];
      } else if (row.head_pipeline) {
        pr.checks = [
          {
            name: `Pipeline #${row.head_pipeline.id}`,
            status: status(row.head_pipeline.status),
            url: safeRemoteUrl(row.head_pipeline.web_url, repo),
          },
        ];
      }
    } catch {
      pr.checksError = "检查状态暂时不可用，请刷新或前往平台核对。";
    }
    return pr;
  }
  async create(
    repo: RemoteRepository,
    input: RemotePrCreate,
  ): Promise<RemotePullRequest> {
    // Discover an existing open request first. Retries after an uncertain POST never create duplicates.
    const query =
      repo.provider === "github"
        ? `state=open&head=${encodeURIComponent(`${repo.path.split("/")[0]}:${input.head}`)}&base=${encodeURIComponent(input.base)}`
        : `state=opened&source_branch=${encodeURIComponent(input.head)}&target_branch=${encodeURIComponent(input.base)}`;
    const existing = await this.api(
      repo,
      "GET",
      `${this.listPath(repo)}?${query}&per_page=100`,
    );
    if (!Array.isArray(existing))
      throw new GitMrError(
        "无法确认是否已有远程请求。",
        "PR_INVALID_RESPONSE",
        502,
      );
    if (existing.length)
      return this.get(
        repo,
        Number(
          repo.provider === "github" ? existing[0].number : existing[0].iid,
        ),
      );
    const body =
      repo.provider === "github"
        ? {
            title: input.title,
            body: input.body,
            head: input.head,
            base: input.base,
            draft: input.draft,
          }
        : {
            title:
              input.draft && !/^Draft:/i.test(input.title)
                ? `Draft: ${input.title}`
                : input.title,
            description: input.body,
            source_branch: input.head,
            target_branch: input.base,
            remove_source_branch: false,
          };
    const row = await this.api(repo, "POST", this.listPath(repo), body);
    return this.get(repo, this.normalize(repo, row).number);
  }
  async updateBranch(repo: RemoteRepository, pr: RemotePullRequest) {
    if (repo.provider === "github")
      await this.api(
        repo,
        "PUT",
        `${this.listPath(repo)}/${pr.number}/update-branch`,
        { expected_head_sha: pr.headSha },
      );
    else
      await this.api(
        repo,
        "PUT",
        `${this.listPath(repo)}/${pr.number}/rebase`,
        { skip_ci: false },
      );
  }
  async merge(
    repo: RemoteRepository,
    pr: RemotePullRequest,
    method: "merge" | "squash" | "rebase",
  ) {
    if (repo.provider === "gitlab" && method === "rebase")
      throw new GitMrError(
        "GitLab 的合并方式由项目设置决定，请选择合并或 squash。",
        "PR_INVALID_METHOD",
        400,
      );
    const result = await this.api(
      repo,
      "PUT",
      `${this.listPath(repo)}/${pr.number}/merge`,
      repo.provider === "github"
        ? { sha: pr.headSha, merge_method: method }
        : {
            sha: pr.headSha,
            squash: method === "squash",
            should_remove_source_branch: false,
          },
    );
    if (repo.provider === "github" && result.merged !== true)
      throw new GitMrError(
        "平台尚未确认合并成功，请刷新请求状态。",
        "PR_MERGE_PENDING",
        409,
      );
  }
}
