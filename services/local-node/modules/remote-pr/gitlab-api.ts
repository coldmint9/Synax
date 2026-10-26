import { getGitLabTokenForHost } from "../../infrastructure/runtime/config/config-store.js";
import { GitMrError } from "../git-mr/errors.js";

const MAX_BYTES = 4 * 1024 * 1024;

export function gitLabHost(value: string): string {
  const host = value.trim().toLowerCase();
  if (!/^[a-z0-9.-]+(?::[0-9]+)?$/.test(host))
    throw new GitMrError(
      "请输入 GitLab 主机，例如 gitlab.com。",
      "INVALID_HOST",
      400,
    );
  try {
    const url = new URL(`https://${host}`);
    if (url.hostname.startsWith(".") || url.hostname.endsWith("."))
      throw new Error();
    return url.host;
  } catch {
    throw new GitMrError("GitLab 主机或端口无效。", "INVALID_HOST", 400);
  }
}

/** Token stays in the header and is never forwarded through redirects or included in errors. */
export async function gitLabRequest(
  host: string,
  method: string,
  endpoint: string,
  body?: unknown,
  token = getGitLabTokenForHost(host),
): Promise<any> {
  host = gitLabHost(host);
  if (!token)
    throw new GitMrError(
      `请在设置 → GitLab 登录中配置 ${host} 的访问令牌。`,
      "PR_AUTH_REQUIRED",
      403,
    );
  const base = new URL(`https://${host}/api/v4/`);
  const url = new URL(endpoint, base);
  if (
    url.origin !== base.origin ||
    !url.pathname.startsWith(base.pathname) ||
    url.hash ||
    url.username ||
    url.password
  )
    throw new GitMrError("GitLab API 路径无效。", "INVALID_ENDPOINT", 400);
  try {
    const response = await fetch(url, {
      method,
      redirect: "error",
      signal: AbortSignal.timeout(60_000),
      headers: {
        "PRIVATE-TOKEN": token,
        Accept: "application/json",
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      if (response.status === 401 || response.status === 403)
        throw new GitMrError(
          "GitLab 登录已失效或权限不足，请在设置中检查 Token 和 api 权限。",
          "PR_AUTH_REQUIRED",
          403,
        );
      if (response.status === 404)
        throw new GitMrError(
          "GitLab 仓库或 MR 不存在，或当前账号无权访问。",
          "PR_NOT_FOUND",
          404,
        );
      if (response.status === 409 || response.status === 422)
        throw new GitMrError(
          "远程状态发生变化或请求被 GitLab 拒绝，请刷新后重试。",
          "PR_REMOTE_CONFLICT",
          409,
        );
      if (response.status === 429)
        throw new GitMrError(
          "GitLab 请求过于频繁，请稍后重试。",
          "PR_RATE_LIMITED",
          502,
        );
      throw new GitMrError(
        "GitLab 请求未完成，请检查平台状态后刷新重试。",
        "PR_REQUEST_FAILED",
        502,
      );
    }
    const reader = response.body?.getReader();
    if (!reader) return {};
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > MAX_BYTES) {
          await reader.cancel();
          throw new GitMrError(
            "GitLab 响应超过读取上限。",
            "PR_INVALID_RESPONSE",
            502,
          );
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }
    const text = Buffer.concat(chunks).toString("utf8").trim();
    try {
      return text ? JSON.parse(text) : {};
    } catch {
      throw new GitMrError(
        "GitLab 返回了无法识别的响应。",
        "PR_INVALID_RESPONSE",
        502,
      );
    }
  } catch (error) {
    if (error instanceof GitMrError) throw error;
    throw new GitMrError(
      "无法连接 GitLab，请检查主机地址、网络和 HTTPS 证书后重试。",
      "PR_REQUEST_FAILED",
      502,
    );
  }
}

export async function validateGitLabAccount(host: string, token?: string) {
  host = gitLabHost(host);
  const user = await gitLabRequest(
    host,
    "GET",
    "user",
    undefined,
    token ?? getGitLabTokenForHost(host),
  );
  if (
    typeof user?.username !== "string" ||
    !user.username ||
    !Number.isSafeInteger(user.id)
  )
    throw new GitMrError(
      "GitLab 未返回有效的登录账号。",
      "PR_INVALID_RESPONSE",
      502,
    );
  return {
    host,
    username: user.username,
    name: typeof user.name === "string" ? user.name : user.username,
  };
}
