import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const files = {
  env: resolve(root, ".env.version"),
  package: resolve(root, "package.json"),
  clientPackage: resolve(root, "client/package.json"),
  lock: resolve(root, "package-lock.json"),
  clientLock: resolve(root, "client/package-lock.json"),
};

const readJson = (file) => JSON.parse(readFileSync(file, "utf8"));
const writeJson = (file, value) => writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);

function readVersion() {
  const match = readFileSync(files.env, "utf8").match(/^SYNAX_VERSION=(\d+\.\d+\.\d+)$/m);
  if (!match) throw new Error(`${files.env} must contain SYNAX_VERSION=x.y.z`);
  return match[1];
}

function bump(version, kind) {
  const [major, minor, patch] = version.split(".").map(Number);
  return kind === "patch" ? `${major}.${minor}.${patch + 1}` : `${major}.${minor + 1}.0`;
}

function sync(version) {
  const packageJson = readJson(files.package);
  const clientPackage = readJson(files.clientPackage);
  const lock = readJson(files.lock);
  const clientLock = readJson(files.clientLock);

  packageJson.version = version;
  clientPackage.version = version;
  lock.version = version;
  lock.packages[""].version = version;
  lock.packages.client.version = version;
  clientLock.version = version;
  clientLock.packages[""].version = version;

  writeFileSync(files.env, `SYNAX_VERSION=${version}\n`);
  writeJson(files.package, packageJson);
  writeJson(files.clientPackage, clientPackage);
  writeJson(files.lock, lock);
  writeJson(files.clientLock, clientLock);

  for (const file of [
    "cli/main.ts",
    "client/src/app/pages/AboutPage.tsx",
    "services/local-node/infrastructure/mcp/mcp-client-manager.ts",
    "services/local-node/modules/agent-runtime/backends/codex-connection.ts",
  ]) {
    const path = resolve(root, file);
    const source = readFileSync(path, "utf8");
    const updated = source
      .replace(/CLI_VERSION = "\d+\.\d+\.\d+"/, `CLI_VERSION = "${version}"`)
      .replace(/const VERSION = "\d+\.\d+\.\d+"/, `const VERSION = "${version}"`)
      .replace(/version: "\d+\.\d+\.\d+"/g, `version: "${version}"`);
    writeFileSync(path, updated);
  }

  const claudePath = resolve(root, "services/local-node/modules/agent-runtime/backends/claude-connection.ts");
  writeFileSync(
    claudePath,
    readFileSync(claudePath, "utf8").replace(/synax\/\d+\.\d+\.\d+/, `synax/${version}`),
  );
}

const command = process.argv[2] ?? "sync";
if (!["sync", "patch", "minor"].includes(command)) {
  throw new Error("Usage: node scripts/release-version.mjs [patch|minor|sync]");
}
const current = readVersion();
const version = command === "sync" ? current : bump(current, command);
sync(version);
console.log(`SYNAX_VERSION=${version}`);
