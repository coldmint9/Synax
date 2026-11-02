import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { logger } from "../../infrastructure/runtime/logger.js";

/**
 * Host toolchain facts rendered into the runtime environment reminder.
 *
 * The reminder is rebuilt every step, so probing has to stay off the critical
 * path: version commands run at most once per TTL per process, only from
 * explicit warm-up points, and rendering reads the last snapshot synchronously.
 * A slow `mvn -version` therefore never delays a turn.
 *
 * Facts describe the host process that spawns agent tools. A WSL session runs
 * its commands inside the distribution instead, so it gets no toolchain facts
 * rather than misleading Windows ones.
 */

export interface HostToolFacts {
  /** Parsed version token; null when the binary exists but printed nothing usable. */
  version: string | null;
  /** Absolute executable the agent's own PATH resolves for this command. */
  path: string;
}

export interface HostFactsSnapshot {
  /** Epoch milliseconds of the probe that produced this snapshot. */
  probedAt: number;
  /** One entry per probed tool in a stable order; null means "not on PATH". */
  tools: Record<string, HostToolFacts | null>;
  /** Toolchain environment variables that are actually set on this host. */
  env: Record<string, string>;
}

export interface HostProbeResult {
  status: number | null;
  /** stdout and stderr joined; `java -version` prints to stderr. */
  output: string;
  timedOut: boolean;
}

export type HostProbeRunner = (
  command: string,
  args: string[],
  options: { timeoutMs: number; env: NodeJS.ProcessEnv; shell: boolean },
) => Promise<HostProbeResult>;

export interface HostFactsProbeOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  /** Test seam: replace real process spawning. */
  run?: HostProbeRunner;
  now?: () => number;
}

interface ToolProbe {
  name: string;
  command: string;
  args: string[];
  timeoutMs?: number;
}

const PROBE_TIMEOUT_MS = 6_000;
/** Gradle has to boot a JVM before it can print its version. */
const JVM_TOOL_PROBE_TIMEOUT_MS = 12_000;
const MAX_PARALLEL_PROBES = 5;
const MAX_PROBE_OUTPUT_CHARS = 8_000;
const SNAPSHOT_TTL_MS = 10 * 60_000;

/** Ordered so the rendered JSON is stable across probes and restarts. */
const TOOL_PROBES: readonly ToolProbe[] = [
  { name: "java", command: "java", args: ["-version"] },
  { name: "mvn", command: "mvn", args: ["-version"], timeoutMs: JVM_TOOL_PROBE_TIMEOUT_MS },
  { name: "gradle", command: "gradle", args: ["--version"], timeoutMs: JVM_TOOL_PROBE_TIMEOUT_MS },
  { name: "node", command: "node", args: ["--version"] },
  { name: "npm", command: "npm", args: ["--version"] },
  { name: "pnpm", command: "pnpm", args: ["--version"] },
  { name: "yarn", command: "yarn", args: ["--version"] },
  { name: "python3", command: "python3", args: ["--version"] },
  { name: "python", command: "python", args: ["--version"] },
  { name: "uv", command: "uv", args: ["--version"] },
  { name: "git", command: "git", args: ["--version"] },
  { name: "go", command: "go", args: ["version"] },
  { name: "rustc", command: "rustc", args: ["--version"] },
  { name: "bash", command: "bash", args: ["--version"] },
  { name: "zsh", command: "zsh", args: ["--version"] },
];

/** Variables that decide which toolchain a shell command actually resolves. */
const TOOLCHAIN_ENV_KEYS = [
  "JAVA_HOME",
  "MAVEN_HOME",
  "M2_HOME",
  "GRADLE_HOME",
  "GRADLE_USER_HOME",
  "NVM_DIR",
  "NVM_BIN",
  "PNPM_HOME",
  "PYENV_ROOT",
  "VIRTUAL_ENV",
  "CONDA_PREFIX",
  "GOROOT",
  "GOPATH",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "HOMEBREW_PREFIX",
] as const;

const VERSION_PATTERNS: Record<string, RegExp> = {
  java: /version "([^"]+)"/,
  mvn: /Apache Maven ([\w.+-]+)/,
  gradle: /Gradle ([\w.+-]+)/,
  node: /^v?(\d[\w.+-]*)$/m,
  npm: /^(\d[\w.+-]*)$/m,
  pnpm: /^(\d[\w.+-]*)$/m,
  yarn: /^v?(\d[\w.+-]*)$/m,
  python3: /Python ([\w.+-]+)/,
  python: /Python ([\w.+-]+)/,
  uv: /uv ([\w.+-]+)/,
  git: /git version ([\w.+-]+)/,
  go: /go version go([\w.+-]+)/,
  rustc: /rustc ([\w.+-]+)/,
  bash: /version ([\w.+-]+)/,
  zsh: /zsh ([\w.+-]+)/,
};

/** Last successful snapshot; renders synchronously, never blocks. */
let snapshot: HostFactsSnapshot | null = null;
let inflight: Promise<HostFactsSnapshot | null> | null = null;

/** Version probes spawn 15 real processes: suites inject snapshots instead. */
export function hostFactsEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.NODE_ENV !== "test";
}

export function readHostFacts(): HostFactsSnapshot | null {
  return snapshot;
}

/** Install a snapshot without probing (tests and explicit callers). */
export function primeHostFacts(next: HostFactsSnapshot | null): void {
  snapshot = next;
}

export function resetHostFacts(): void {
  snapshot = null;
  inflight = null;
}

/**
 * Resolve a command the way the agent's shell would, without spawning a lookup
 * helper. Windows resolves through PATHEXT so `.cmd` shims (npm, pnpm) are found.
 */
export function resolveOnPath(
  command: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string | null {
  const pathValue = env.PATH ?? env.Path ?? "";
  const windows = platform === "win32";
  const directories = pathValue.split(windows ? ";" : ":");
  const extensions = windows
    ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean)
    : [""];
  for (const rawDirectory of directories) {
    // Windows PATH entries may be quoted, and an empty segment is not the cwd here.
    const directory = rawDirectory.trim().replace(/^"(.*)"$/, "$1");
    if (!directory) continue;
    for (const extension of extensions) {
      const candidate = path.join(directory, `${command}${extension.toLowerCase()}`);
      try {
        if (!fs.statSync(candidate).isFile()) continue;
        if (!windows) fs.accessSync(candidate, fs.constants.X_OK);
        return candidate;
      } catch {
        /* Continue the search, exactly like the shell does. */
      }
    }
  }
  return null;
}

/** Extract the token a developer recognizes; fall back to the first line. */
export function parseToolVersion(
  name: string,
  output: string,
  status: number | null = 0,
): string | null {
  const pattern = VERSION_PATTERNS[name];
  const match = pattern?.exec(output);
  if (match?.[1]) return match[1].trim();
  // Only a successful command's first line is a version. A failing launcher
  // (macOS's `/usr/bin/java` stub without a JDK) prints an error message that
  // must not be reported as one.
  if (status !== 0) return null;
  const line = output
    .split(/\r?\n/)
    .map((candidate) => candidate.trim())
    .find(Boolean);
  if (!line) return null;
  return line.length > 60 ? line.slice(0, 60) : line;
}

function spawnProbe(
  command: string,
  args: string[],
  options: { timeoutMs: number; env: NodeJS.ProcessEnv; shell: boolean },
): Promise<HostProbeResult> {
  return new Promise((resolve) => {
    let output = "";
    let timedOut = false;
    let settled = false;
    const append = (chunk: Buffer) => {
      if (output.length >= MAX_PROBE_OUTPUT_CHARS) return;
      output += chunk.toString();
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(command, args, {
        env: options.env,
        shell: options.shell,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolve({ status: null, output, timedOut });
      return;
    }
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGKILL");
      } catch {
        /* Already gone. */
      }
    }, options.timeoutMs);
    timer.unref?.();
    const settle = (status: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, output, timedOut });
    };
    child.stdout?.on("data", append);
    child.stderr?.on("data", append);
    child.once("error", () => settle(null));
    child.once("close", (status) => settle(status));
  });
}

async function probeTool(
  probe: ToolProbe,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  run: HostProbeRunner,
): Promise<HostToolFacts | null> {
  const executable = resolveOnPath(probe.command, env, platform);
  if (!executable) return null;
  const result = await run(executable, probe.args, {
    timeoutMs: probe.timeoutMs ?? PROBE_TIMEOUT_MS,
    env,
    // `.cmd`/`.bat` shims only start through the platform command processor.
    shell: platform === "win32" && /\.(?:cmd|bat)$/i.test(executable),
  });
  // A stalled probe still proves the tool exists; report it without a version.
  return {
    version: parseToolVersion(probe.name, result.output, result.status),
    path: executable,
  };
}

function readToolchainEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  const values: Record<string, string> = {};
  for (const key of TOOLCHAIN_ENV_KEYS) {
    const value = env[key];
    if (typeof value === "string" && value.trim()) values[key] = value;
  }
  return values;
}

/** Probe every tool concurrently, bounded so a cold host stays responsive. */
export async function probeHostFacts(
  options: HostFactsProbeOptions = {},
): Promise<HostFactsSnapshot> {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const run = options.run ?? spawnProbe;
  const queue = [...TOOL_PROBES];
  const found = new Map<string, HostToolFacts | null>();
  await Promise.all(
    Array.from({ length: Math.min(MAX_PARALLEL_PROBES, queue.length) }, async () => {
      for (let probe = queue.shift(); probe; probe = queue.shift()) {
        try {
          found.set(probe.name, await probeTool(probe, env, platform, run));
        } catch {
          // One broken probe must not cost the rest of the toolchain.
          found.set(probe.name, null);
        }
      }
    }),
  );
  const tools: Record<string, HostToolFacts | null> = {};
  for (const probe of TOOL_PROBES) tools[probe.name] = found.get(probe.name) ?? null;
  return { probedAt: options.now?.() ?? Date.now(), tools, env: readToolchainEnvironment(env) };
}

/**
 * Return the cached snapshot, refreshing it when stale. Concurrent callers share
 * one probe, and a failed probe keeps the previous snapshot instead of throwing
 * into prompt assembly.
 */
export async function ensureHostFacts(
  options: HostFactsProbeOptions = {},
): Promise<HostFactsSnapshot | null> {
  const now = options.now?.() ?? Date.now();
  if (snapshot && now - snapshot.probedAt < SNAPSHOT_TTL_MS) return snapshot;
  if (inflight) return inflight;
  if (!hostFactsEnabled(options.env ?? process.env)) return snapshot;
  inflight = probeHostFacts(options)
    .then((facts) => {
      snapshot = facts;
      return facts;
    })
    .catch((error: unknown) => {
      logger.debug({ err: error }, "Host toolchain probe skipped");
      return snapshot;
    })
    .finally(() => {
      inflight = null;
    });
  return inflight;
}
