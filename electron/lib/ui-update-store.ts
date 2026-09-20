import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  decodeUiArchive,
  sha256,
  validateManifest,
  type UiFile,
} from "./ui-update-format.js";
import { fetchUiArtifact, type UiRelease } from "./ui-update-feed.js";

interface UiState {
  active: string | null;
  pending: string | null;
  previous: string | null;
  awaitingHealth: boolean;
  rejected: string[];
}
const initialState = (): UiState => ({
  active: null,
  pending: null,
  previous: null,
  awaitingHealth: false,
  rejected: [],
});

async function readJson(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, "utf8"));
}

async function atomicJson(file: string, value: unknown): Promise<void> {
  const temp = `${file}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temp, JSON.stringify(value));
    await fs.rename(temp, file);
  } finally {
    await fs.rm(temp, { force: true });
  }
}

async function verifyFiles(root: string, files: UiFile[]): Promise<void> {
  for (const entry of files) {
    const file = path.join(root, ...entry.path.split("/"));
    const stat = await fs.lstat(file);
    if (
      !stat.isFile() ||
      stat.isSymbolicLink() ||
      stat.size !== entry.size ||
      sha256(await fs.readFile(file)) !== entry.sha256
    ) {
      throw new Error(`UI file verification failed: ${entry.path}`);
    }
  }
}

export class UiUpdateStore {
  private state: UiState = initialState();
  private currentRoot: string;
  constructor(
    private readonly directory: string,
    private readonly bundledRoot: string,
    private readonly appVersion: string,
  ) {
    this.currentRoot = bundledRoot;
  }

  get root(): string {
    return this.currentRoot;
  }
  get needsHealthCheck(): boolean {
    return this.state.awaitingHealth;
  }
  get currentVersion(): string | null {
    return this.state.active;
  }
  get pendingVersion(): string | null {
    return this.state.pending;
  }
  get rejected(): string[] {
    return this.state.rejected;
  }
  private snapshot(version: string): string {
    return path.join(this.directory, `ui-${version}`);
  }
  private async save(): Promise<void> {
    await atomicJson(path.join(this.directory, "state.json"), this.state);
  }

  private async cleanCache(): Promise<void> {
    const keep = new Set(
      [this.state.active, this.state.pending, this.state.previous].filter(
        Boolean,
      ),
    );
    for (const entry of await fs.readdir(this.directory, {
      withFileTypes: true,
    })) {
      if (!entry.isDirectory()) continue;
      if (
        /^\.stage-[0-9a-f-]{36}$/.test(entry.name) ||
        (/^ui-\d+\.\d+\.\d+$/.test(entry.name) &&
          !keep.has(entry.name.slice(3)))
      ) {
        await fs.rm(path.join(this.directory, entry.name), {
          recursive: true,
          force: true,
        });
      }
    }
  }

  private async loadValid(version: string | null): Promise<string | null> {
    if (!version || !/^\d+\.\d+\.\d+$/.test(version)) return null;
    const root = this.snapshot(version);
    try {
      const manifest = validateManifest(
        await readJson(path.join(root, "manifest.json")),
      );
      if (
        manifest.version !== version ||
        manifest.appVersion !== this.appVersion
      )
        return null;
      await verifyFiles(root, manifest.files);
      return root;
    } catch (error) {
      console.warn("[ui-update] invalid cached UI snapshot", version, error);
      return null;
    }
  }

  async initialize(): Promise<void> {
    await fs.mkdir(this.directory, { recursive: true });
    try {
      const input = (await readJson(
        path.join(this.directory, "state.json"),
      )) as UiState;
      if (
        !input ||
        !Array.isArray(input.rejected) ||
        ![input.active, input.pending, input.previous].every(
          (v) => v === null || typeof v === "string",
        ) ||
        typeof input.awaitingHealth !== "boolean"
      )
        throw new Error("Invalid UI state");
      this.state = {
        ...input,
        rejected: input.rejected
          .filter((v) => /^\d+\.\d+\.\d+$/.test(v))
          .slice(-20),
      };
    } catch {
      this.state = initialState();
    }

    if (this.state.awaitingHealth) {
      if (this.state.active) this.state.rejected.push(this.state.active);
      this.state.active = this.state.previous;
      this.state.previous = null;
      this.state.awaitingHealth = false;
    }
    if (this.state.pending) {
      const validPending = await this.loadValid(this.state.pending);
      if (validPending) {
        this.state.previous = this.state.active;
        this.state.active = this.state.pending;
        this.state.awaitingHealth = true;
      }
      this.state.pending = null;
    }
    let root = await this.loadValid(this.state.active);
    if (!root) {
      if (this.state.active) this.state.rejected.push(this.state.active);
      this.state.active = this.state.previous;
      this.state.previous = null;
      this.state.awaitingHealth = false;
      root = await this.loadValid(this.state.active);
      if (!root) this.state.active = null;
    }
    this.currentRoot = root ?? this.bundledRoot;
    this.state.rejected = [...new Set(this.state.rejected)].slice(-20);
    await this.save();
    await this.cleanCache().catch((error) =>
      console.warn("[ui-update] cache cleanup failed", error),
    );
  }

  async markHealthy(): Promise<void> {
    if (!this.state.awaitingHealth) return;
    this.state.awaitingHealth = false;
    await this.save();
    await this.cleanCache().catch((error) =>
      console.warn("[ui-update] cache cleanup failed", error),
    );
  }

  async rollback(): Promise<boolean> {
    if (!this.state.awaitingHealth) return false;
    if (this.state.active) this.state.rejected.push(this.state.active);
    this.state.active = this.state.previous;
    this.state.previous = null;
    this.state.awaitingHealth = false;
    this.currentRoot =
      (await this.loadValid(this.state.active)) ?? this.bundledRoot;
    if (this.currentRoot === this.bundledRoot) this.state.active = null;
    await this.save();
    return true;
  }

  async prepare(release: UiRelease): Promise<"delta" | "full"> {
    const manifest = release.manifest;
    if (
      manifest.appVersion !== this.appVersion ||
      this.state.rejected.includes(manifest.version)
    ) {
      throw new Error("UI release is not compatible with this app");
    }
    const delta =
      manifest.delta?.baseVersion === this.state.active &&
      release.assets.some((asset) => asset.name === manifest.delta?.name)
        ? manifest.delta
        : undefined;
    // A failed or missing delta is retried as a *UI-only* full archive.
    let mode: "delta" | "full" = delta ? "delta" : "full";
    let incoming: Map<string, Buffer>;
    try {
      const artifact = delta ?? manifest.full;
      const expected = delta
        ? manifest.files.filter((entry) => delta.paths.includes(entry.path))
        : manifest.files;
      incoming = decodeUiArchive(
        await fetchUiArtifact(release, artifact),
        expected,
      );
    } catch (error) {
      if (!delta) throw error;
      console.warn("[ui-update] delta unavailable; fetching full UI", error);
      mode = "full";
      incoming = decodeUiArchive(
        await fetchUiArtifact(release, manifest.full),
        manifest.files,
      );
    }
    const staging = path.join(this.directory, `.stage-${randomUUID()}`);
    await fs.mkdir(staging, { recursive: true });
    try {
      for (const entry of manifest.files) {
        const destination = path.join(staging, ...entry.path.split("/"));
        await fs.mkdir(path.dirname(destination), { recursive: true });
        const contents =
          incoming.get(entry.path) ??
          (delta && mode === "delta" && this.state.active
            ? await fs.readFile(
                path.join(
                  this.snapshot(this.state.active),
                  ...entry.path.split("/"),
                ),
              )
            : undefined);
        if (
          !contents ||
          contents.length !== entry.size ||
          sha256(contents) !== entry.sha256
        ) {
          throw new Error(`UI file checksum mismatch: ${entry.path}`);
        }
        await fs.writeFile(destination, contents, { flag: "wx" });
      }
      await verifyFiles(staging, manifest.files);
      await fs.writeFile(
        path.join(staging, "manifest.json"),
        JSON.stringify(manifest),
        { flag: "wx" },
      );
      const destination = this.snapshot(manifest.version);
      await fs.rm(destination, { recursive: true, force: true });
      await fs.rename(staging, destination);
      this.state.pending = manifest.version;
      await this.save();
      return mode;
    } catch (error) {
      if (
        mode === "delta" &&
        delta &&
        error instanceof Error &&
        (/checksum mismatch/.test(error.message) ||
          ("code" in error && error.code === "ENOENT"))
      ) {
        console.warn("[ui-update] delta base invalid; fetching full UI", error);
        return this.prepare({
          ...release,
          manifest: { ...manifest, delta: undefined },
        });
      }
      throw error;
    } finally {
      await fs.rm(staging, { recursive: true, force: true });
    }
  }
}
