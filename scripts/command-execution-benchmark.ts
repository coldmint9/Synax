import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

// A local launch benchmark, independent of production sessions and data.
const root = await mkdtemp(path.join(os.tmpdir(), "synax-command-benchmark-"));
process.env.DATA_ROOT = root;
const { runCommand, terminateOwnedCommands } = await import("../services/local-node/modules/agent-runtime/tools/exec-async.js");
const options = { cwd: root, env: { PATH: process.env.PATH }, inheritEnv: false, timeoutMs: 10_000 };
const samples: Record<string, number[]> = { separate: [], combined: [], separateBurst: [], combinedBurst: [] };

async function command(combined: boolean, source: string) {
  if (!combined) {
    const checked = await runCommand("/bin/bash", ["-n", "-c", source], options);
    if (checked.status !== 0) throw new Error("Preflight failed");
  }
  const result = await runCommand("/bin/bash", ["-o", "pipefail", "-c", source], { ...options, validateBash: combined });
  if (result.status !== 0 || result.stdout !== "ok") throw new Error("Command failed");
}

try {
  for (let index = 0; index < 3; index++) {
    await command(false, "printf ok");
    await command(true, "printf ok");
    await terminateOwnedCommands();
  }
  for (let index = 0; index < 20; index++) {
    // Alternate order to reduce warm-up and host-load bias.
    for (const combined of index % 2 ? [true, false] : [false, true]) {
      const started = performance.now();
      await command(combined, "printf ok");
      samples[combined ? "combined" : "separate"].push(performance.now() - started);
      await terminateOwnedCommands();
    }
  }
  for (let index = 0; index < 6; index++) {
    for (const combined of index % 2 ? [true, false] : [false, true]) {
      const started = performance.now();
      await Promise.all(Array.from({ length: 8 }, () => command(combined, "sleep 0.1; printf ok")));
      samples[combined ? "combinedBurst" : "separateBurst"].push(performance.now() - started);
      await terminateOwnedCommands();
    }
  }
  const stats = Object.fromEntries(Object.entries(samples).map(([name, values]) => {
    const sorted = [...values].sort((a, b) => a - b);
    return [name, { count: values.length, p50Ms: sorted[Math.ceil(sorted.length * 0.5) - 1], p95Ms: sorted[Math.ceil(sorted.length * 0.95) - 1] }];
  }));
  const report = { createdAt: new Date().toISOString(), node: process.version, platform: `${os.platform()}-${os.arch()}`,
    scope: "Local owned-command launch. Separate = two owned registrations, combined = validation within one owned group. Burst = 8 concurrent 100ms commands. Excludes production resource admission, durable leases and tool registry; cleanup between samples is outside timing.",
    stats, samples };
  if (process.argv[2]) {
    const output = path.resolve(process.argv[2]);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, JSON.stringify(report, null, 2) + "\n");
  }
  console.log(JSON.stringify(report, null, 2));
} finally {
  await terminateOwnedCommands();
  await rm(root, { recursive: true, force: true });
}
