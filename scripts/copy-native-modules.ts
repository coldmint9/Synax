import {
  cpSync,
  mkdirSync,
  readdirSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
  realpathSync,
} from "node:fs";
import { createRequire } from "node:module";
import { join, dirname, relative, sep } from "node:path";

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

// esbuild resolves its platform executable relative to its package at runtime.
cpSync(join(src, "@esbuild"), join(dest, "@esbuild"), { recursive: true });

// tree-sitter packages use dynamic import() at runtime
const dynamicPackages = [
  "esbuild",
  "parse5",
  "entities",
  "react",
  "react-dom",
  "scheduler",
  "lucide-react",
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

// Ship the compiler's fixed runtime dependency graph intact, preserving nested
// versions. A repo-local smoke test alone can hide missing packages via ancestors.
const runtimeSeen = new Set<string>();
const modulesReal = realpathSync(src);
function copyArtifactRuntime(name: string, from: string) {
  const resolver = createRequire(join(from, "package.json"));
  let entry: string;
  try {
    entry = resolver.resolve(`${name}/package.json`);
  } catch {
    entry = resolver.resolve(name);
  }
  let packageDir = dirname(realpathSync(entry));
  while (!existsSync(join(packageDir, "package.json"))) {
    const parent = dirname(packageDir);
    if (parent === packageDir) throw new Error(`Cannot locate package ${name}`);
    packageDir = parent;
  }
  const location = relative(modulesReal, packageDir);
  if (location.startsWith(".." + sep) || location === "..")
    throw new Error(`Artifact dependency outside packaged tree: ${name}`);
  if (runtimeSeen.has(packageDir)) return;
  runtimeSeen.add(packageDir);
  cpSync(packageDir, join(dest, location), { recursive: true });
  const manifest = JSON.parse(
    readFileSync(join(packageDir, "package.json"), "utf8"),
  );
  for (const dependency of Object.keys(manifest.dependencies ?? {}))
    copyArtifactRuntime(dependency, packageDir);
}
for (const name of [
  "esbuild",
  "parse5",
  "react",
  "react-dom",
  "lucide-react",
  "d3",
])
  copyArtifactRuntime(name, root);
console.log(`  copied ${runtimeSeen.size} artifact runtime packages`);

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
