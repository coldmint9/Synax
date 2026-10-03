import { execFile } from "node:child_process";
import path from "node:path";

export interface WslDistribution {
  name: string;
  version: 2;
  default: boolean;
  state?: string;
}

export interface WslCommandSpec {
  command: "wsl.exe";
  args: string[];
}

export class WslError extends Error {
  constructor(
    message: string,
    readonly code = "WSL_UNAVAILABLE",
  ) {
    super(message);
    this.name = "WslError";
  }
}

export function decodeWslOutput(output: Buffer | string): string {
  if (typeof output === "string") return output.replace(/^\ufeff/, "");
  if (!output.length) return "";
  const hasUtf16Bom =
    output.length >= 2 && output[0] === 0xff && output[1] === 0xfe;
  const nulHeavy =
    output
      .subarray(0, Math.min(output.length, 128))
      .filter((byte) => byte === 0).length > 4;
  return output
    .toString(hasUtf16Bom || nulHeavy ? "utf16le" : "utf8")
    .replace(/^\ufeff/, "");
}

/** Parse from the right so localized headers/state labels never become protocol. */
export function parseWslListVerbose(output: string): WslDistribution[] {
  const result: WslDistribution[] = [];
  for (const rawLine of output.replace(/\0/g, "").split(/\r?\n/)) {
    const match = rawLine.match(/^\s*(\*)?\s*(.*?)\s+(\S+)\s+([12])\s*$/);
    if (!match || !match[2].trim()) continue;
    const version = Number(match[4]);
    if (version !== 2) continue;
    result.push({
      name: match[2].trim(),
      state: match[3],
      version: 2,
      default: Boolean(match[1]),
    });
  }
  return result;
}

function execWsl(
  args: string[],
  options: { timeout?: number; env?: NodeJS.ProcessEnv } = {},
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      process.env.SYNAX_WSL_EXE || "wsl.exe",
      args,
      {
        windowsHide: true,
        timeout: options.timeout ?? 15_000,
        maxBuffer: 8 * 1024 * 1024,
        encoding: "buffer",
        env: options.env,
      },
      (error, stdout, stderr) => {
        const decodedStdout = decodeWslOutput(stdout as unknown as Buffer);
        const decodedStderr = decodeWslOutput(stderr as unknown as Buffer);
        if (error) {
          reject(
            new WslError(
              decodedStderr.trim() || error.message,
              (error as NodeJS.ErrnoException).code || "WSL_COMMAND_FAILED",
            ),
          );
          return;
        }
        resolve({ stdout: decodedStdout, stderr: decodedStderr });
      },
    );
  });
}

export async function listWslDistributions(
  options: { platform?: NodeJS.Platform } = {},
): Promise<WslDistribution[]> {
  if ((options.platform ?? process.platform) !== "win32") return [];
  const { stdout } = await execWsl(["--list", "--verbose"]);
  return parseWslListVerbose(stdout);
}

export function assertWslDistributionName(name: string): string {
  const value = name.trim();
  if (!value || value.includes("\0") || /[\\/\r\n]/.test(value)) {
    throw new WslError(
      "WSL distribution name is invalid.",
      "WSL_DISTRIBUTION_INVALID",
    );
  }
  return value;
}

export async function assertWslDistribution(
  name: string,
): Promise<WslDistribution> {
  name = assertWslDistributionName(name);
  const found = (await listWslDistributions()).find(
    (item) => item.name.toLocaleLowerCase() === name.toLocaleLowerCase(),
  );
  if (!found)
    throw new WslError(
      `WSL2 distribution is not installed: ${name}`,
      "WSL_DISTRIBUTION_MISSING",
    );
  return found;
}

const WSL_ENV_BLOCKED = new Set(["PATH", "HOME", "SHELL", "COMSPEC"]);
const WSL_ENV_INTERNAL = new Set([
  "AGENT_SESSION_INIT",
  "WIKI_JOB_INIT",
  "SYNAX_AGENT_SESSION_CHILD",
  "SYNAX_WIKI_JOB_CHILD",
  "SYNAX_RUNTIME_HOST_ID",
  "SYNAX_RUNTIME_DATA_ROOT",
]);

/** Keep the Windows launcher environment, but forward only explicit overrides through WSLENV. */
export function wslLauncherEnvironment(
  overrides?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  const forwarded: string[] = [];
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (
      value === undefined ||
      WSL_ENV_BLOCKED.has(key.toUpperCase()) ||
      WSL_ENV_INTERNAL.has(key)
    )
      continue;
    if (process.env[key] === value) continue;
    env[key] = value;
    forwarded.push(key);
  }
  const existing = (process.env.WSLENV ?? "").split(":").filter(Boolean);
  env.WSLENV = [...new Set([...existing, ...forwarded])].join(":");
  return env;
}

export function wslCommandSpec(
  distribution: string,
  cwd: string,
  command: string,
  args: string[],
  options: { shell?: boolean; ownerId?: string } = {},
): WslCommandSpec {
  distribution = assertWslDistributionName(distribution);
  cwd = assertLinuxAbsolutePath(cwd);
  const base = ["--distribution", distribution, "--cd", cwd, "--exec"];
  const target = options.shell
    ? ["/bin/sh", "-c", command]
    : [command, ...args];
  if (options.ownerId) {
    return {
      command: "wsl.exe",
      args: [
        ...base,
        "/usr/bin/env",
        `SYNAX_PROCESS_OWNER=${options.ownerId}`,
        "/usr/bin/setsid",
        ...target,
      ],
    };
  }
  return { command: "wsl.exe", args: [...base, ...target] };
}

export async function runWsl(
  distribution: string,
  cwd: string,
  command: string,
  args: string[] = [],
  options: { timeout?: number; env?: NodeJS.ProcessEnv; shell?: boolean } = {},
): Promise<{ stdout: string; stderr: string }> {
  await assertWslDistribution(distribution);
  const spec = wslCommandSpec(distribution, cwd, command, args, options);
  return execWsl(spec.args, { timeout: options.timeout, env: options.env });
}

export function assertLinuxAbsolutePath(input: string): string {
  const value = input.trim();
  if (!value || value.includes("\0") || !path.posix.isAbsolute(value)) {
    throw new WslError(
      "WSL workspace path must be an absolute Linux path.",
      "WSL_PATH_INVALID",
    );
  }
  return path.posix.normalize(value);
}

export async function canonicalizeWslPath(
  distribution: string,
  input: string,
): Promise<string> {
  const candidate = assertLinuxAbsolutePath(input);
  const { stdout } = await runWsl(distribution, "/", "/bin/sh", [
    "-c",
    'test -d "$1" && readlink -f -- "$1"',
    "synax",
    candidate,
  ]);
  const canonical = stdout.trim();
  if (!canonical || !path.posix.isAbsolute(canonical)) {
    throw new WslError(
      `WSL workspace directory is unavailable: ${candidate}`,
      "WSL_PATH_MISSING",
    );
  }
  return path.posix.normalize(canonical);
}

export async function wslHomeDirectory(distribution: string): Promise<string> {
  const { stdout } = await runWsl(distribution, "/", "/bin/sh", [
    "-c",
    'printf %s "$HOME"',
  ]);
  return assertLinuxAbsolutePath(stdout.trim() || "/");
}

export interface WslOwnedProcess {
  pid: number;
  pgid: number;
}

const OWNER_LOOKUP_SCRIPT = `owner=$1
for file in /proc/[0-9]*/environ; do
  [ -r "$file" ] || continue
  if tr '\\0' '\\n' < "$file" 2>/dev/null | grep -Fqx "SYNAX_PROCESS_OWNER=$owner"; then
    pid=\${file#/proc/}; pid=\${pid%/environ}
    pgid=$(ps -o pgid= -p "$pid" 2>/dev/null | tr -d ' ')
    [ -n "$pgid" ] && printf '%s %s' "$pid" "$pgid" && exit 0
  fi
done
exit 1`;

export async function findWslOwnedProcess(
  distribution: string,
  ownerId: string,
): Promise<WslOwnedProcess | null> {
  try {
    const { stdout } = await runWsl(
      distribution,
      "/",
      "/bin/sh",
      ["-c", OWNER_LOOKUP_SCRIPT, "synax", ownerId],
      { timeout: 4_000 },
    );
    const [pid, pgid] = stdout.trim().split(/\s+/).map(Number);
    return pid > 0 && pgid > 0 ? { pid, pgid } : null;
  } catch {
    return null;
  }
}

export async function stopWslOwnedProcess(
  distribution: string,
  ownerId: string,
  expectedPid?: number | null,
  expectedPgid?: number | null,
): Promise<boolean> {
  const found = await findWslOwnedProcess(distribution, ownerId);
  if (!found) return true;
  if (expectedPgid && found.pgid !== expectedPgid) return false;
  const script = `pgid=$1
kill -TERM -- "-$pgid" 2>/dev/null || exit 1
for i in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
  kill -0 -- "-$pgid" 2>/dev/null || exit 0
  sleep 0.1
done
kill -KILL -- "-$pgid" 2>/dev/null || true
for i in 1 2 3 4 5 6 7 8 9 10; do
  kill -0 -- "-$pgid" 2>/dev/null || exit 0
  sleep 0.1
done
exit 1`;
  try {
    await runWsl(
      distribution,
      "/",
      "/bin/sh",
      ["-c", script, "synax", String(found.pgid)],
      { timeout: 5_000 },
    );
    return true;
  } catch {
    return false;
  }
}
