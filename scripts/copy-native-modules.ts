import { cpSync, mkdirSync, readdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";

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

// Copy libsql main package
for (const pkg of libsqlPackages) {
  cpSync(join(src, pkg), join(dest, pkg), { recursive: true });
  console.log(`  copied ${pkg}`);
}

// tree-sitter packages use dynamic import() at runtime
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

// Drop stale packaged skills when upgrading from the retired prototype platform.
rmSync(join(serverDist, "skills/builtin"), { recursive: true, force: true });
cpSync(join(root, "api/skills/builtin"), join(serverDist, "skills/builtin"), {
  recursive: true,
});
for (const name of ["eval-set.json", "eval-set-synax.json", "fixtures"]) {
  cpSync(
    join(root, "api/prototypes/tree-embedding-bench", name),
    join(serverDist, "prototypes/tree-embedding-bench", name),
    { recursive: true },
  );
}
rmSync(join(serverDist, "migrations"), { recursive: true, force: true });
cpSync(join(root, "api/db/migrations"), join(serverDist, "migrations"), {
  recursive: true,
});
mkdirSync(join(serverDist, "workers"), { recursive: true });
cpSync(
  join(root, "api/workers/owned-process-runner.cjs"),
  join(serverDist, "workers/owned-process-runner.cjs"),
);
console.log("native modules ready.");
