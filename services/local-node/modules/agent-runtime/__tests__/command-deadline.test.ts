import { expect, it, vi } from "vitest";
import { runCommand } from "../tools/exec-async.js";

it.skipIf(process.platform === "win32")("kills a timed-out command and its descendant before returning", async () => {
  const result = await runCommand(process.execPath, ["-e", `
    const {spawn}=require('node:child_process');
    const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    console.log(child.pid); setInterval(()=>{},1000);
  `], { timeoutMs: 500 });
  expect(result.timedOut).toBe(true);
  const pid = Number(result.stdout.trim()); expect(pid).toBeGreaterThan(0);
  await vi.waitFor(() => expect(() => process.kill(pid, 0)).toThrow(), { timeout: 3000 });
}, 6000);

it("stops a streaming producer once its consumer has enough results", async () => {
  const result = await runCommand(process.execPath, ["-e", "setInterval(()=>console.log('match'),10)"], {
    timeoutMs: 5000, onStdout: () => false,
  });
  expect(result.stoppedEarly).toBe(true);
  expect(result.stdout).toContain("match");
  expect(result.timedOut).toBe(false);
});
