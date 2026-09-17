import { fork, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  externalCommandEnvironment,
  prepareOwnedProcess,
  recordOwnedPid,
  releaseOwnedProcess,
} from "./process-ownership.js";

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
  const child = fork(launcherPath(), [], {
    cwd: options.cwd,
    detached: grouped,
    env: {
      ...externalCommandEnvironment(options.env, options.inheritEnv !== false),
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
      command,
      args,
      cwd: options.cwd,
      shell: options.shell === true,
      background: options.background === true,
    });
  } catch (error) {
    child.kill("SIGKILL");
    releaseOwnedProcess(ticket.id);
    throw error;
  }
  return Object.assign(child, { ownedProcessId: ticket.id });
}
