import fs from "node:fs";
import path from "node:path";
import { DATA_ROOT } from "../../../infrastructure/runtime/env.js";
import { runtimeAsset } from "../../../infrastructure/runtime/runtime-paths.js";
import { logger } from "../../../infrastructure/runtime/logger.js";
import { sandboxConfigForSession } from "../sandbox/index.js";
import { agentRuntimeStore } from "../session-store.js";
import { sessionHomeName } from "../tools/session-home.js";
import { workspaceRoot } from "../tools/workspace.js";
import { SANDBOX_DIRECTORY } from "./limits.js";

/** Hard-killed runs cannot clean up after themselves; a later call sweeps them. */
const STALE_RUN_MS = 24 * 60 * 60_000;
const MAX_SWEPT_RUNS = 20;

/**
 * One isolated place per session for Python's persistent helper files and data.
 *
 * The sandbox outlives a single call: parsed data, helper modules and caches can
 * be reused by the next script. Every call still gets its own `run-*` directory
 * so parallel calls in one step cannot overwrite each other's violation reports.
 */
export interface PreparedPythonSandbox {
  /** Persistent session sandbox; HOME, TMPDIR and SYNAX_SANDBOX point here. */
  root: string;
  /** Per-call directory reserved for the sticky violation report; no source files. */
  runDirectory: string;
  guardPath: string;
  /** Virtual filename for __file__, argv[0] and tracebacks; never created. */
  scriptPath: string;
  config: {
    private: string;
    script: string;
    sandbox: string;
    readRoots: string[];
    writeRoots: string[];
    blockedExtensions: string[];
    maxDepth: number;
    restricted: boolean;
  };
  cwd: string;
  env: NodeJS.ProcessEnv;
  dispose(): void;
}

function realpathOrSelf(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function uniqueRoots(roots: string[]): string[] {
  const seen = new Set<string>();
  for (const root of roots.map(realpathOrSelf)) seen.add(root);
  return [...seen];
}

function sweepStaleRuns(root: string): void {
  let names: string[];
  try {
    names = fs.readdirSync(root);
  } catch {
    return;
  }
  const cutoff = Date.now() - STALE_RUN_MS;
  let removed = 0;
  for (const name of names) {
    if (removed >= MAX_SWEPT_RUNS || !name.startsWith("run-")) continue;
    const candidate = path.join(root, name);
    try {
      if (fs.lstatSync(candidate).mtimeMs >= cutoff) continue;
      fs.rmSync(candidate, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 });
      removed += 1;
    } catch {
      // Another call may own it right now; a later sweep will retry.
    }
  }
}

/**
 * A delegated writer's declared writeScope narrows what its scripts may modify.
 * File tools enforce it per path; arbitrary code has to be bounded the same way.
 */
function delegatedWriteRoots(sessionId: string, workspace: string): string[] | null {
  const metadata = agentRuntimeStore.tryGetSession(sessionId)?.sessionMetadata;
  const subagent = metadata?.subagentProfile as { profile?: { writeScope?: string[] } } | undefined;
  const specialist = metadata?.specialist as { writeScope?: string[] } | undefined;
  const scope = [subagent?.profile?.writeScope, specialist?.writeScope]
    .find((values): values is string[] => Array.isArray(values) && values.length > 0);
  if (!scope) return null;
  return scope.map((entry) => realpathOrSelf(path.resolve(workspace, entry)));
}

export function preparePythonSandbox(input: {
  sessionId: string;
  cwd: string;
}): PreparedPythonSandbox {
  const root = path.join(DATA_ROOT, SANDBOX_DIRECTORY, sessionHomeName(input.sessionId));
  const scratch = path.join(root, "tmp");
  // Resolve every fallible input before creating a run directory, so a missing
  // workspace or config cannot leave an empty directory behind.
  const config = sandboxConfigForSession(input.sessionId);
  const workspace = workspaceRoot(input.sessionId);
  const guardPath = runtimeAsset(import.meta.url, "guard.py", "python-execution/guard.py");
  // Reads and writes share one boundary: the session workspace plus the sandbox
  // that holds persistent helpers/data. Unrestricted sessions lift it entirely, which is the
  // same rule file tools and the bash redirect check follow.
  const boundary = uniqueRoots([workspace, ...(config.workspaceRoots ?? []), root]);
  const unrestricted = config.unrestricted;
  const delegated = unrestricted ? null : delegatedWriteRoots(input.sessionId, workspace);
  fs.mkdirSync(scratch, { recursive: true, mode: 0o700 });
  sweepStaleRuns(root);
  const runDirectory = fs.mkdtempSync(path.join(root, "run-"));
  fs.chmodSync(runDirectory, 0o700);

  const dispose = (): void => {
    try {
      fs.rmSync(runDirectory, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
    } catch (error) {
      // A just-killed child can still hold a handle on Windows. Losing one run
      // directory is a leak; replacing the script's real result with a cleanup
      // failure would hide what actually happened.
      logger.warn(
        { event: "python.run.cleanup", runDirectory, message: error instanceof Error ? error.message : String(error) },
        "python.run could not remove its run directory",
      );
    }
  };

  // Use the same canonical virtual path that guard.py places in sys.argv and
  // tracebacks. The path is an identity only; no source file is created.
  const scriptPath = path.join(fs.realpathSync(runDirectory), "main.py");

  const env: NodeJS.ProcessEnv = {
    HOME: root,
    USERPROFILE: root,
    TMPDIR: scratch,
    TMP: scratch,
    TEMP: scratch,
    XDG_CACHE_HOME: path.join(root, ".cache"),
    XDG_CONFIG_HOME: path.join(root, ".config"),
    XDG_DATA_HOME: path.join(root, ".local", "share"),
    PYTHONIOENCODING: "utf-8",
    PYTHONUTF8: "1",
    SYNAX_SANDBOX: root,
    SYNAX_WORKSPACE: input.cwd,
  };
  // Windows needs its own directory to load system DLLs; nothing else is inherited,
  // so no proxy, provider credential or host toolchain reaches the script.
  for (const key of ["SystemRoot", "WINDIR", "SYSTEMROOT"]) {
    const value = process.env[key];
    if (value) env[key] = value;
  }

  return {
    root,
    runDirectory,
    guardPath,
    scriptPath,
    config: {
      private: runDirectory,
      script: scriptPath,
      sandbox: root,
      readRoots: boundary,
      writeRoots: delegated ? uniqueRoots([...delegated, root]) : boundary,
      blockedExtensions: unrestricted ? [] : [...config.blockedExtensions],
      maxDepth: Number.isFinite(config.maxDepth) ? config.maxDepth : 4096,
      restricted: !unrestricted,
    },
    cwd: input.cwd,
    env,
    dispose,
  };
}
