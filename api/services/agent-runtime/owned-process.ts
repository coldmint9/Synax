import { fork, type ChildProcess } from "node:child_process";
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
} from "./process-ownership.js";
import { parseWslUncPath } from "../workspace-location.js";
import {
  findWslOwnedProcess,
  wslCommandSpec,
  wslLauncherEnvironment,
} from "../wsl.js";

function launcherPath(): string {
  const candidates: string[] = [];
  try {
    const here = path.dirname(fileURLToPath(import.meta.url));
    candidates.push(
      path.resolve(here, "../../workers/owned-process-runner.cjs"),
      path.join(here, "workers/owned-process-runner.cjs"),
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
): ChildProcess & { ownedProcessId: string } {
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
  const child = fork(launcherPath(), [], {
    cwd: wsl ? undefined : options.cwd,
    detached: grouped,
    env: {
      ...(wsl
        ? wslLauncherEnvironment(options.env)
        : externalCommandEnvironment(
            options.env,
            options.inheritEnv !== false,
          )),
      SYNAX_PROCESS_OWNER: ticket.id,
      ELECTRON_RUN_AS_NODE: "1",
    },
    execArgv: [],
    stdio: [options.stdin ?? "pipe", "pipe", "pipe", "ipc"],
  });
  let completedCode: number | null = null;
  child.on("message", (message: any) => {
    if (message?.type === "finished" && typeof message.code === "number")
      completedCode = message.code;
  });
  try {
    recordOwnedPid(ticket.id, child.pid);
    child.once("close", (code) =>
      releaseOwnedProcess(ticket.id, completedCode ?? code),
    );
    child.once("error", () => releaseOwnedProcess(ticket.id));
    child.send({
      type: "start",
      command: target.command,
      args: target.args,
      cwd: wsl ? undefined : options.cwd,
      shell: wsl ? false : options.shell === true,
      background: options.background === true,
    });
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
  return Object.assign(child, { ownedProcessId: ticket.id });
}
