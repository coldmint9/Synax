import {
  cpSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { join, sep } from "node:path";
import { validateCuaArtifact } from "./validate-cua-artifact.js";

const root = join(import.meta.dirname, "..");
const serverDist = join(root, "server-dist");
const src = join(root, "node_modules");

// Place a package.json in server-dist so require() resolves correctly
writeFileSync(
  join(serverDist, "package.json"),
  JSON.stringify({ name: "synax-server", private: true }),
);
console.log("  wrote server-dist/package.json");

const dest = join(serverDist, "node_modules");
// This directory is generated; do not ship obsolete compiler dependencies from earlier builds.
rmSync(dest, { recursive: true, force: true });
mkdirSync(dest, { recursive: true });

// Copy libsql, @libsql/client, and their runtime dependencies.
const libsqlPackages = [
  "libsql",
  "@neon-rs/load",
  "detect-libc",
  "js-base64",
  "promise-limit",
  "ws",
];
const libsqlPlatforms = readdirSync(src).filter((d) => d.startsWith("@libsql"));

// Copy @libsql scoped packages (platform binaries)
for (const scope of libsqlPlatforms) {
  const scopeSrc = join(src, scope);
  const scopeDest = join(dest, scope);
  cpSync(scopeSrc, scopeDest, { recursive: true });
  console.log(`  copied ${scope}`);
}

// Synax owns ripgrep; copy the universal package so both the CLI and desktop
// server can resolve the binary without depending on the host machine.
const ripgrepPackage = "@vscode/ripgrep-universal";
mkdirSync(join(dest, "@vscode"), { recursive: true });
cpSync(join(src, ripgrepPackage), join(dest, ripgrepPackage), {
  recursive: true,
});
console.log(`  copied ${ripgrepPackage}`);

// Copy libsql main package
for (const pkg of libsqlPackages) {
  cpSync(join(src, pkg), join(dest, pkg), { recursive: true });
  console.log(`  copied ${pkg}`);
}

// These runtime packages resolve resources dynamically.
const dynamicPackages = [
  "@anthropic-ai/claude-agent-sdk",
  "playwright-core",
  "tree-sitter",
  "node-gyp-build",
  "node-addon-api",
  "node-pty",
];

const treeSitterLangs = readdirSync(src).filter(
  (d) => d.startsWith("tree-sitter-") && d !== "tree-sitter",
);

for (const pkg of [...dynamicPackages, ...treeSitterLangs]) {
  cpSync(join(src, pkg), join(dest, pkg), { recursive: true });
  console.log(`  copied ${pkg}`);
}

// Trash ships platform binaries and uses package-relative URLs. Keep the package
// and its runtime dependency tree intact instead of bundling it into a CJS file.
const copiedRuntime = new Set<string>();
function copyRuntimePackage(
  name: string,
  sourceParent = src,
  destParent = dest,
): void {
  const sourceDir = join(sourceParent, name);
  const targetDir = join(destParent, name);
  if (copiedRuntime.has(targetDir)) return;
  if (!existsSync(sourceDir))
    throw new Error(`Missing packaged runtime dependency: ${sourceDir}`);
  copiedRuntime.add(targetDir);
  mkdirSync(destParent, { recursive: true });
  cpSync(sourceDir, targetDir, {
    recursive: true,
    filter: (source) =>
      !source.startsWith(`${join(sourceDir, "node_modules")}${sep}`) &&
      source !== join(sourceDir, "node_modules"),
  });
  const manifest = JSON.parse(
    readFileSync(join(sourceDir, "package.json"), "utf8"),
  ) as { dependencies?: Record<string, string> };
  for (const dependency of Object.keys(manifest.dependencies ?? {})) {
    const nested = join(sourceDir, "node_modules", dependency);
    if (existsSync(nested))
      copyRuntimePackage(
        dependency,
        join(sourceDir, "node_modules"),
        join(targetDir, "node_modules"),
      );
    else copyRuntimePackage(dependency);
  }
}
copyRuntimePackage("trash");
// The standalone Computer Use helper owns the CUA SDK and its native driver.
// Synax never loads them itself, so they ship beside the helper instead of with
// the API sidecar. Keeping them out of server-dist also keeps the helper's
// permission identity separate from the main app's bundle contents.
const cuaHelperModules = join(root, "cua-helper-dist", "node_modules");
mkdirSync(cuaHelperModules, { recursive: true });
copyRuntimePackage("@trycua/cua-driver", src, cuaHelperModules);
// These are direct runtime imports from the generated CUA bindings. Keep them
// explicit as well as manifest-driven so a hoisted npm layout cannot leave the
// helper with an incomplete dependency tree.
copyRuntimePackage("@ubjs/core", src, cuaHelperModules);
copyRuntimePackage("@ubjs/node", src, cuaHelperModules);
for (const name of readdirSync(join(src, "@trycua")).filter(name => name.startsWith("cua-driver-")))
  copyRuntimePackage(`@trycua/${name}`, src, cuaHelperModules);
for (const name of readdirSync(join(src, "@ubjs")).filter(name => name.startsWith("node-")))
  copyRuntimePackage(`@ubjs/${name}`, src, cuaHelperModules);

validateCuaArtifact({
  helperRoot: join(root, "cua-helper-dist"),
  platform: process.platform,
  arch: process.arch,
  requireDriver: false,
});


// Drop stale packaged skills when upgrading from the retired prototype platform.
rmSync(join(serverDist, "skills/builtin"), { recursive: true, force: true });
cpSync(join(root, "services/local-node/skills/builtin"), join(serverDist, "skills/builtin"), {
  recursive: true,
});
// Remove retired analysis artifacts from incremental builds.
rmSync(join(serverDist, "prototypes/tree-embedding-bench"), { recursive: true, force: true });
for (const name of ["analyzer-worker.cjs", "scan-pipeline-worker.thread.cjs"]) {
  rmSync(join(serverDist, "workers", name), { force: true });
}
for (const name of readdirSync(dest).filter(name => name === "tree-sitter" || name.startsWith("tree-sitter-"))) {
  rmSync(join(dest, name), { recursive: true, force: true });
}
rmSync(join(serverDist, "migrations"), { recursive: true, force: true });
cpSync(join(root, "services/local-node/infrastructure/database/migrations"), join(serverDist, "migrations"), {
  recursive: true,
});
mkdirSync(join(serverDist, "workers"), { recursive: true });
cpSync(
  join(root, "services/worker/jobs/owned-process-runner.cjs"),
  join(serverDist, "workers/owned-process-runner.cjs"),
);
console.log("native modules ready.");
