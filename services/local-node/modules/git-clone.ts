import { execFile } from "node:child_process";
import { mkdir, rm } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

/** Clone failures carry the user-facing reason; the board shows it as-is. */
export class GitCloneError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitCloneError";
  }
}

export interface CloneRepositoryInput {
  repoUrl: string;
  /** Absolute directory to create; it must not exist yet. */
  destination: string;
  /** Optional HTTPS credential for the remote host. */
  token?: string | null;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Injected in tests; production uses `git`. */
  run?: typeof execFileAsync;
}

interface ParsedRemote {
  url: string;
  host: string | null;
  https: boolean;
}

/**
 * Accepts the remote forms hosted Git providers hand out
 * (HTTPS, `git@host:path`, `ssh://`) and rejects anything else, because the URL
 * is handed to `git` and must not be able to smuggle options.
 */
export function parseCloneRemote(repoUrl: string): ParsedRemote {
  const url = repoUrl.trim();
  if (!url || url.startsWith("-")) throw new GitCloneError("仓库地址不合法。");
  const scp = /^git@([^:/]+):(.+)$/.exec(url);
  if (scp) return { url, host: scp[1].toLowerCase(), https: false };
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new GitCloneError("仓库地址不合法。"); }
    const protocol = parsed.protocol.toLowerCase();
    if (!["http:", "https:", "ssh:", "git:"].includes(protocol) || !parsed.hostname) {
      throw new GitCloneError("仓库地址不合法。");
    }
    return { url, host: parsed.hostname.toLowerCase(), https: protocol === "http:" || protocol === "https:" };
  }
  throw new GitCloneError("仓库地址不是受支持的 Git 地址。");
}

/**
 * Clones one repository into an empty destination.
 *
 * A token is passed through git's environment-based config (`GIT_CONFIG_*`),
 * never argv, so it cannot show up in the process list or in a logged command.
 * The destination is removed again when the clone fails, otherwise the next
 * attempt would see a half-written directory and refuse to clone.
 */
export async function cloneRepository(input: CloneRepositoryInput): Promise<void> {
  const remote = parseCloneRemote(input.repoUrl);
  const run = input.run ?? execFileAsync;
  await mkdir(path.dirname(input.destination), { recursive: true });
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_TERMINAL_PROMPT: "0" };
  if (remote.https && remote.host && input.token) {
    const header = Buffer.from(`oauth2:${input.token}`).toString("base64");
    env.GIT_CONFIG_COUNT = "1";
    env.GIT_CONFIG_KEY_0 = `http.https://${remote.host}/.extraHeader`;
    env.GIT_CONFIG_VALUE_0 = `Authorization: Basic ${header}`;
  }
  try {
    await run("git", ["clone", remote.url, input.destination], {
      env,
      cwd: path.dirname(input.destination),
      timeout: input.timeoutMs ?? 10 * 60_000,
      maxBuffer: 8 * 1024 * 1024,
      ...(input.signal ? { signal: input.signal } : {}),
    });
  } catch (error) {
    await rm(input.destination, { recursive: true, force: true }).catch(() => undefined);
    throw new GitCloneError(cloneFailureMessage(error));
  }
}

function cloneFailureMessage(error: unknown): string {
  const stderr = (error as { stderr?: unknown })?.stderr;
  const detail = typeof stderr === "string" ? stderr : Buffer.isBuffer(stderr) ? stderr.toString("utf8") : "";
  const fatal = /fatal:\s*(.+)/.exec(detail)?.[1]?.trim();
  if (fatal) return `拉取仓库失败：${fatal}`;
  if ((error as NodeJS.ErrnoException)?.code === "ENOENT") return "本机未安装 git，无法拉取仓库。";
  return error instanceof Error && error.message ? `拉取仓库失败：${error.message}` : "拉取仓库失败。";
}
