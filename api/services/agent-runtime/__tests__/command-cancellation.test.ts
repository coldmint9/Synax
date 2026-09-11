import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runShellCommand, withCommandSignal } from "../tools/exec-async.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});
function workspace() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synax-cancel-"));
  dirs.push(dir);
  return dir;
}
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(process.platform === "win32")(
  "owned command cancellation",
  () => {
    it("kills the command group on abort without cancelling another command", async () => {
      const dir = workspace(),
        controller = new AbortController();
      const stopped = withCommandSignal(controller.signal, () =>
        runShellCommand(
          "trap '' TERM; echo ready > ready; sleep 0.3; echo escaped > escaped",
          { cwd: dir },
        ),
      );
      const independent = runShellCommand("sleep 0.1; echo kept", { cwd: dir });
      await vi.waitFor(() =>
        expect(fs.existsSync(path.join(dir, "ready"))).toBe(true),
      );
      controller.abort();
      expect((await stopped).error?.code).toBe("ABORT_ERR");
      expect((await independent).stdout.trim()).toBe("kept");
      await delay(350);
      expect(fs.existsSync(path.join(dir, "escaped"))).toBe(false);
      const alreadyAborted = await withCommandSignal(controller.signal, () =>
        runShellCommand("echo escaped > escaped", { cwd: dir }),
      );
      expect(alreadyAborted.error?.code).toBe("ABORT_ERR");
      expect(fs.existsSync(path.join(dir, "escaped"))).toBe(false);
    });

    it("the actual worker shutdown kills its shell group before exiting", async () => {
      const dir = workspace();
      const helper = pathToFileURL(
        path.resolve("api/services/agent-runtime/tools/exec-async.ts"),
      ).href;
      const runner = pathToFileURL(
        path.resolve("api/workers/agent-session-runner.ts"),
      ).href;
      const script = path.join(dir, "probe.mts");
      fs.writeFileSync(
        script,
        `import { runShellCommand } from ${JSON.stringify(helper)};\nimport ${JSON.stringify(runner)};\nvoid runShellCommand("echo ready > ready; sleep 1.5; echo escaped > escaped",{cwd:${JSON.stringify(dir)}});\n`,
      );
      const child = spawn(process.execPath, ["--import", "tsx", script], {
        cwd: process.cwd(),
        env: {
          ...process.env,
          DATA_ROOT: path.join(dir, "data"),
          AGENT_SESSION_INIT: JSON.stringify({
            sessionId: "shutdown-probe",
            projectId: "test",
            workDir: dir,
          }),
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
      });
      let stderr = "";
      child.stderr?.on("data", (d) => {
        stderr += d.toString();
      });
      child.stdout?.resume();
      const exited = new Promise<number | null>((resolve) =>
        child.once("exit", resolve),
      );
      try {
        await vi.waitFor(
          () =>
            expect(fs.existsSync(path.join(dir, "ready")), stderr).toBe(true),
          { timeout: 5000 },
        );
        child.kill("SIGTERM");
        expect(await exited).toBe(0);
        await delay(1600);
        expect(fs.existsSync(path.join(dir, "escaped"))).toBe(false);
      } finally {
        if (child.exitCode === null && child.signalCode === null)
          child.kill("SIGKILL");
      }
    }, 10000);
  },
);
