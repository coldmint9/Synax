import type {
  PrProvider,
  RemoteRepository,
  RemoteChoice,
} from "./contracts.js";
import { GitMrError } from "../git-mr/errors.js";
/** Parse only repository endpoints from configured git remotes; never expose credentials. */
export function parseRemote(
  remote: string,
  value: string,
  provider?: PrProvider,
): RemoteRepository {
  if (
    !/^[a-zA-Z0-9][a-zA-Z0-9._/-]{0,100}$/.test(remote) ||
    remote.includes("..")
  )
    throw new GitMrError("远程名称无效。", "INVALID_REMOTE", 400);
  let host: string, repository: string;
  const scp = /^(?:[^@/\s]+@)?([a-zA-Z0-9.-]+):([^\s]+)$/.exec(value);
  if (scp && !value.includes("://")) {
    host = scp[1];
    repository = scp[2];
  } else {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new GitMrError(
        "PR 需要 SSH 或 HTTPS 远程仓库。",
        "UNSUPPORTED_REMOTE",
        400,
      );
    }
    if (!["https:", "ssh:"].includes(url.protocol) || url.search || url.hash)
      throw new GitMrError(
        "PR 需要 SSH 或 HTTPS 远程仓库。",
        "UNSUPPORTED_REMOTE",
        400,
      );
    host = url.hostname;
    repository = url.pathname.replace(/^\//, "");
    if (url.port && url.protocol === "https:") host += `:${url.port}`;
  }
  host = host.toLowerCase();
  repository = repository.replace(/\/$/, "").replace(/\.git$/, "");
  if (
    !/^[a-zA-Z0-9.-]+(?::[0-9]+)?$/.test(host) ||
    !/^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+$/.test(repository) ||
    repository.split("/").some((s) => s === "." || s === "..")
  )
    throw new GitMrError("无法识别远程仓库地址。", "INVALID_REMOTE", 400);
  const inferred =
    host === "github.com"
      ? "github"
      : host === "gitlab.com"
        ? "gitlab"
        : undefined;
  if (inferred && provider && inferred !== provider)
    throw new GitMrError(
      "远程平台与仓库地址不匹配。",
      "PROVIDER_MISMATCH",
      400,
    );
  const selected = inferred ?? provider;
  if (!selected)
    throw new GitMrError(
      "请选择此私有主机使用 GitHub 还是 GitLab。",
      "PROVIDER_REQUIRED",
      400,
    );
  if (selected === "github" && repository.split("/").length !== 2)
    throw new GitMrError("GitHub 仓库应为 owner/repo。", "INVALID_REMOTE", 400);
  return { remote, host, path: repository, provider: selected };
}
export function remoteChoice(name: string, url: string): RemoteChoice {
  try {
    return { name, ...parseRemote(name, url) };
  } catch (error) {
    if (error instanceof GitMrError && error.code === "PROVIDER_REQUIRED") {
      const value = parseRemote(name, url, "gitlab");
      return { name, host: value.host, path: value.path };
    }
    return {
      name,
      unsupportedReason:
        error instanceof Error ? error.message : "不支持的远程地址",
    };
  }
}
export function safeRemoteUrl(value: unknown, repo: RemoteRepository): string {
  if (typeof value !== "string") return "";
  try {
    const url = new URL(value);
    return url.protocol === "https:" &&
      url.host === repo.host &&
      !url.username &&
      !url.password
      ? url.toString()
      : "";
  } catch {
    return "";
  }
}
