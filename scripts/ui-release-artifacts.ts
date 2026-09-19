import fs from "node:fs/promises";
import path from "node:path";
import { encodeUiArchive, sha256, validateManifest, validUiPath, type UiArtifact, type UiFile, type UiManifest } from "../electron/lib/ui-update-format.js";

async function readUiFiles(root: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  async function visit(directory: string, relative = ""): Promise<void> {
    for (const item of await fs.readdir(directory, { withFileTypes: true })) {
      if (item.name === ".DS_Store") continue;
      const name = relative ? `${relative}/${item.name}` : item.name;
      if (!validUiPath(name) || item.isSymbolicLink()) throw new Error(`Unsafe UI path: ${name}`);
      const absolute = path.join(directory, item.name);
      if (item.isDirectory()) await visit(absolute, name);
      else if (item.isFile()) files.set(name, await fs.readFile(absolute));
      else throw new Error(`Unsupported UI asset: ${name}`);
    }
  }
  await visit(root);
  return files;
}

export async function createUiReleaseArtifacts(root: string, version: string, appVersion: string, previous?: UiManifest): Promise<{ manifest: UiManifest; full: Buffer; delta?: Buffer }> {
  const assets = await readUiFiles(root);
  const entries: UiFile[] = [...assets].sort(([a], [b]) => a.localeCompare(b)).map(([file, bytes]) => ({
    path: file, size: bytes.length, sha256: sha256(bytes),
  }));
  const full = encodeUiArchive(assets);
  const artifact = (name: string, bytes: Buffer): UiArtifact => ({ name, sha256: sha256(bytes), size: bytes.length });
  const manifest: UiManifest = { format: 1, version, appVersion, files: entries, full: artifact("ui-full.json.gz", full) };
  let delta: Buffer | undefined;
  if (previous) {
    if (previous.appVersion !== appVersion) throw new Error("Delta base must target the same desktop app");
    const known = new Map(previous.files.map((entry) => [entry.path, entry.sha256]));
    const changed = new Map([...assets].filter(([file, bytes]) => known.get(file) !== sha256(bytes)));
    delta = encodeUiArchive(changed);
    manifest.delta = { ...artifact("ui-delta.json.gz", delta), baseVersion: previous.version, paths: [...changed.keys()].sort() };
  }
  validateManifest(manifest);
  return { manifest, full, delta };
}
