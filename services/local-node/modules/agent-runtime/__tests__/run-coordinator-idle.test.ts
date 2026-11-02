import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it } from "vitest";

// A child process gives this regression a real wall-clock bound: the broken
// microtask loop also prevents Vitest's own timeout timer from firing.
it.each(["waitForIdle", "waitForSessionIdle"])(
  "%s lets parent cleanup timers release a settled descendant",
  async method => {
    const module = new URL("../run-coordinator.ts", import.meta.url).href;
    const { stdout } = await promisify(execFile)(process.execPath, [
      "--import", "tsx/esm", "--input-type=module", "-e", `
        import { RunCoordinator } from ${JSON.stringify(module)};
        const coordinator = new RunCoordinator();
        const owner = { runId: 'run', stopping: true,
          controller: new AbortController(), task: Promise.resolve() };
        coordinator.owners.set('child', owner);
        let released = false;
        setTimeout(() => {
          coordinator.owners.delete('child');
          released = true;
        }, 30);
        await coordinator[${JSON.stringify(method)}]('child');
        console.log(JSON.stringify({ released, active: coordinator.isActive('child') }));
      `,
    ], { timeout: 8_000, env: { ...process.env, LOG_LEVEL: "silent" } });
    expect(JSON.parse(stdout.trim())).toEqual({ released: true, active: false });
  }, 10_000,
);
