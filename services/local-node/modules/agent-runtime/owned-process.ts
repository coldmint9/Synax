import { fork, spawn, type ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  externalCommandEnvironment,
  prepareOwnedProcess,
  recordOwnedPid,
  recordOwnedRuntime,
  recordOwnedRuntimeTarget,
  releaseOwnedProcess,
  waitForAuthoritativeLease,
} from "./process-ownership.js";
import { parseWslUncPath } from "../workspace-location.js";
import { guardProcessGroup, type ProcessGroupGuard } from "./process-guardian.js";
import {
  findWslOwnedProcess,
  wslCommandSpec,
  wslLauncherEnvironment,
} from "../../infrastructure/wsl/wsl.js";

function launcherPath(): string {
  const candidates: string[] = [];
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    candidates.push(
      path.resolve(here, "../../../worker/jobs/owned-process-runner.cjs"),
      path.join(here, "../../../worker/jobs/owned-process-runner.cjs"),
    );
  } catch {
    /* Bundled CJS uses the entry path below. */
  }
  if (process.argv[1])
    candidates.push(
      path.join(
        path.dirname(process.argv[1]),
        "workers/owned-process-runner.cjs",
      ),
      path.join(path.dirname(process.argv[1]), "owned-process-runner.cjs"),
    );
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found)
    throw new Error("Owned process launcher is missing from this build.");
  return found;
}

export function spawnOwnedProcess(
  command: string,
  args: string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    inheritEnv?: boolean;
    shell?: boolean;
    stdin?: "pipe" | "ignore";
    sessionId?: string;
    background?: boolean;
    commandLabel?: string;
  } = {},
): ChildProcess & {
  ownedProcessId: string;
  /** Bounded cleanup wait for callers that require synchronous confirmation. */
  ownedProcessClosed: Promise<void>;
  /** Actual cleanup acknowledgement; remains pending through inspection timeouts. */
  ownedProcessReaped: Promise<void>;
} {
  const grouped = process.platform !== "win32";
  const ticket = prepareOwnedProcess(
    options.background
      ? (options.commandLabel ?? command)
      : options.shell
        ? "shell"
        : path.basename(command),
    grouped,
    options,
  );
  const wsl = options.cwd ? parseWslUncPath(options.cwd) : null;
  if (wsl) recordOwnedRuntimeTarget(ticket.id, wsl.distribution);
  const target = wsl
    ? wslCommandSpec(wsl.distribution, wsl.path, command, args, {
        shell: options.shell,
        ownerId: ticket.id,
      })
    : { command, args };
  // The gate is replaced by the target with exec: PID, process group and owner
  // marker remain stable, without a Node/Electron helper for every command.
  // fd 3 keeps the start handshake separate from the command's stdin.
  const direct = grouped && !wsl && !options.background;
  const env = {
    ...(wsl
      ? wslLauncherEnvironment(options.env)
      : externalCommandEnvironment(options.env, options.inheritEnv !== false)),
    SYNAX_PROCESS_OWNER: ticket.id,
    ELECTRON_RUN_AS_NODE: "1",
  };
  const child = direct ? spawn("/bin/sh", [
    "-c",
    'IFS= read -r start <&3 && [ "$start" = start ] || exit 125; exec 3<&-; '
      + 'command -v "$1" >/dev/null 2>&1 || { printf "ENOENT: %s\\n" "$1" >&2; exit 127; }; exec "$@"',
    "synax-command",
    ...(options.shell ? ["/bin/sh", "-c", [command, ...args].join(" ")] : [command, ...args]),
  ], {
    cwd: options.cwd,
    detached: true,
    env,
    stdio: [options.stdin ?? "pipe", "pipe", "pipe", "pipe"],
  }) : fork(launcherPath(), [], {
    cwd: wsl ? undefined : options.cwd,
    detached: grouped,
    env: {
      ...env,
      ELECTRON_RUN_AS_NODE: "1",
    },
    execArgv: [],
    stdio: [options.stdin ?? "pipe", "pipe", "pipe", "ipc"],
  });
  const gate = direct ? child.stdio[3] as Writable : undefined;
  gate?.on("error", () => { /* cancellation may close the gate before start */ });
  let completedCode: number | null = null;
  child.on("message", (message: any) => {
    if (message?.type === "finished" && typeof message.code === "number")
      completedCode = message.code;
  });
  const sendStart = () => {
    if (child.killed || child.exitCode !== null || child.signalCode !== null) return;
    if (gate) {
      gate.end("start\n");
      return;
    }
    child.send({
      type: "start",
      command: target.command,
      args: target.args,
      cwd: wsl ? undefined : options.cwd,
      shell: wsl ? false : options.shell === true,
      background: options.background === true,
    });
  };
  let guard: ProcessGroupGuard | undefined;
  const closed = new Promise<number | null>((resolve) => {
    child.once("close", resolve);
  });
  const ownedProcessReaped = closed.then(async (code) => {
    if (guard) await guard.closed;
    releaseOwnedProcess(ticket.id, completedCode ?? code);
  });
  const ownedProcessClosed = closed.then(async () => {
    if (guard) await guard.release();
    await ownedProcessReaped;
  });
  // Raw ChildProcess callers can observe stream closure without awaiting the
  // stronger tree-closure promise. Keep a failed cleanup lease for recovery.
  void ownedProcessClosed.catch(() => {});
  void ownedProcessReaped.catch(() => {});
  try {
    recordOwnedPid(ticket.id, child.pid);
    if (direct && child.pid) guard = guardProcessGroup(child, ticket.id);
    child.once("error", () => {
      if (!child.pid) releaseOwnedProcess(ticket.id);
    });
    void Promise.all([
      waitForAuthoritativeLease(ticket.id),
      guard?.ready,
    ]).then(sendStart).catch(() => {
      try { child.kill("SIGKILL"); } catch {}
    });
    child.once("close", () => gate?.destroy());
    if (wsl) {
      void (async () => {
        for (let attempt = 0; attempt < 20; attempt += 1) {
          const owned = await findWslOwnedProcess(wsl.distribution, ticket.id);
          if (owned) {
            recordOwnedRuntime(ticket.id, {
              kind: "wsl",
              distribution: wsl.distribution,
              ...owned,
            });
            return;
          }
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
      })();
    }
  } catch (error) {
    child.kill("SIGKILL");
    releaseOwnedProcess(ticket.id);
    throw error;
  }
  return Object.assign(child, { ownedProcessId: ticket.id, ownedProcessClosed, ownedProcessReaped });
}
