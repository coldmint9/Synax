import { execFile, fork } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build, type Options } from "tsup";
import { afterAll, beforeAll, expect, it } from "vitest";
import type { AgentSessionChildMessage } from "../../../infrastructure/runtime/ipc/agent-session-protocol.js";
import { RustRuntimeSupervisor } from "../../../infrastructure/runtime/rust-sidecar.js";
import buildOptions from "../../../../../tsup.config.js";

const root = fileURLToPath(new URL("../../../../../", import.meta.url));
const sourceEntry = path.join(root, "services/worker/jobs/agent-session-runner.ts");
let directory: string;

beforeAll(async () => {
  // Keep external native dependencies resolvable, but never use the user's data.
  directory = await mkdtemp(path.join(root, "node_modules/.agent-worker-startup-"));
  await build({
    ...(buildOptions as Options),
    entry: { "workers/agent-session-runner": sourceEntry },
    outDir: directory,
    silent: true,
  });
}, 60_000);

afterAll(async () => {
  if (directory) await rm(directory, { recursive: true, force: true });
});

it.each(["source", "bundle"])(
  "starts the %s worker and handles IPC without mocked runtime modules",
  async (mode) => {
    const entry = mode === "source"
      ? sourceEntry
      : path.join(directory, "workers/agent-session-runner.cjs");
    const sessionId = "startup-probe";
    const dataRoot = path.join(directory, `data-${mode}`);
    const supervisor = new RustRuntimeSupervisor({ dataRoot });
    await supervisor.start();
    const child = fork(entry, [], {
      cwd: root,
      env: {
        ...process.env,
        DATA_ROOT: dataRoot,
        SYNAX_AGENT_SESSION_IN_PROCESS: undefined,
        SYNAX_AGENT_SESSION_CHILD: "1",
        SYNAX_RECORDED_START: "1",
        AGENT_SESSION_INIT: JSON.stringify({ sessionId, projectId: "probe", workDir: directory }),
      },
      execArgv: mode === "source" ? ["--import", "tsx/esm"] : [],
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    let stderr = "";
    let stdout = "";
    let response: Extract<AgentSessionChildMessage, { type: "context:compact:error" }> | undefined;
    child.stdout?.on("data", (data) => { stdout += data; });
    child.stderr?.on("data", (data) => { stderr += data; });
    const closed = new Promise<void>((resolve) => child.once("close", () => resolve()));
    try {
      await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => {
          finish(new Error(`Worker startup/shutdown timed out: ${stderr}`));
        }, 15_000);
        const finish = (error?: Error) => {
          clearTimeout(timer);
          error ? reject(error) : resolve();
        };
        child.once("error", finish);
        child.once("exit", (code) => {
          finish(code === 0 && response
            ? undefined
            : new Error(`Worker exited (${code}) before completing IPC: ${stdout}\n${stderr}`));
        });
        child.on("message", (message: AgentSessionChildMessage) => {
          if (message.type === "session:booted") child.send({ type: "session:initialize" });
          if (message.type === "session:ready") {
            if (message.sessionId !== sessionId) return finish(new Error("Wrong ready session"));
            // A missing session must produce a request error, not crash the worker.
            child.send({ type: "context:compact", requestId: "probe-compact" });
          }
          if (message.type === "context:compact:error") {
            response = message;
            child.send({ type: "session:interrupt", reason: "Startup probe completed." });
          }
        });
      });
      expect(response).toMatchObject({ sessionId, requestId: "probe-compact" });
      expect(response?.error).toContain(sessionId);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
      await closed;
      await supervisor.stop();
    }
  },
  40_000,
);
