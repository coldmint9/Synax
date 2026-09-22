/** Explicit acceptance probe. Run only on a Windows host with an installed WSL distro.
 * Unlike general smoke scripts, absence is a failure, never silently a pass. */
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import assert from "node:assert/strict";
import {
  listWslDistributions,
  runWsl,
  canonicalizeWslPath,
} from "../api/services/wsl.js";
import { workspaceLocationHostPath } from "../api/services/workspace-location.js";
import { readSnapshot } from "../api/services/agent-runtime/artifacts/snapshot.js";
import { compileArtifact } from "../api/services/agent-runtime/artifacts/compiler.js";
if (process.platform !== "win32")
  throw new Error(
    "Artifact WSL acceptance requires a Windows WSL host. Not verified.",
  );
const distros = await listWslDistributions();
const distribution =
  process.env.SYNAX_WSL_DISTRIBUTION ??
  distros.find((d) => d.default)?.name ??
  distros[0]?.name;
if (!distribution)
  throw new Error("No WSL distribution available. Not verified.");
const temp = `/tmp/synax-artifact-acceptance-${Date.now()}`;
try {
  await runWsl(distribution, "/", "/bin/sh", [
    "-c",
    'mkdir -p "$1" && printf "%s" "<button id=demo>WSL artifact</button>" > "$1/index.html" && ln -s /etc/passwd "$1/escape.html"',
    "artifact-qa",
    temp,
  ]);
  const host = workspaceLocationHostPath({
    kind: "wsl",
    distribution,
    path: await canonicalizeWslPath(distribution, temp),
  });
  assert.equal(
    (await fs.readFile(path.join(host, "index.html"), "utf8")).includes(
      "WSL artifact",
    ),
    true,
  );
  const result = await compileArtifact(
    readSnapshot(host, "index.html"),
    "html",
  );
  assert.ok(result.html.includes("WSL artifact"));
  assert.ok(result.html.includes("Content-Security-Policy"));
  assert.throws(() => readSnapshot(host, "escape.html"));
  await fs.writeFile(
    path.join(os.tmpdir(), "synax-wsl-artifact-acceptance.json"),
    JSON.stringify(
      {
        platform: process.platform,
        distribution,
        compiled: true,
        symlinkEscapeBlocked: true,
        date: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  console.log(
    "PASS actual WSL artifact snapshot, compile and symlink containment",
  );
} finally {
  await runWsl(distribution, "/", "/bin/rm", ["-rf", "--", temp]);
}
