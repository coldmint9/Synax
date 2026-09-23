import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { getRawSqlite } from "../../db/index.js";
import { DATA_ROOT } from "../../lib/env.js";
import { GitMrError } from "./errors.js";
import type { MergeRequest, MergePreset, MergeProposal } from "./contracts.js";

export class GitMrStore {
  constructor(readonly directory = path.join(DATA_ROOT, "git-mr")) {}
  private filename(kind: string, id: string) {
    if (!/^[a-zA-Z0-9_-]{1,160}$/.test(id))
      throw new GitMrError("Invalid record identifier.", "INVALID_ID", 400);
    return path.join(this.directory, kind, `${id}.json`);
  }
  async read<T>(kind: string, id: string): Promise<T> {
    try {
      return JSON.parse(
        await fs.readFile(this.filename(kind, id), "utf8"),
      ) as T;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        throw new GitMrError("Merge record not found.", "NOT_FOUND", 404);
      throw error;
    }
  }
  async write<T extends { id: string }>(kind: string, item: T): Promise<void> {
    const filename = this.filename(kind, item.id);
    await fs.mkdir(path.dirname(filename), { recursive: true, mode: 0o700 });
    const temporary = `${filename}.${randomUUID()}.tmp`;
    await fs.writeFile(temporary, JSON.stringify(item), { mode: 0o600 });
    await fs.rename(temporary, filename);
  }
  async list<T extends { projectId: string }>(
    kind: string,
    projectId: string,
  ): Promise<T[]> {
    const names = await fs
      .readdir(path.join(this.directory, kind))
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return [];
        throw error;
      });
    const records = await Promise.all(
      names
        .filter((name) => name.endsWith(".json"))
        .map((name) => this.read<T>(kind, name.slice(0, -5))),
    );
    return records.filter((record) => record.projectId === projectId);
  }
  async get(projectId: string, id: string) {
    const record = await this.read<MergeRequest>("requests", id);
    if (record.projectId !== projectId)
      throw new GitMrError("Merge request not found.", "NOT_FOUND", 404);
    return record;
  }
  async save(record: MergeRequest, message?: string) {
    record.version++;
    record.updatedAt = new Date().toISOString();
    if (message) record.events.push({ at: record.updatedAt, message });
    await this.write("requests", record);
    return record;
  }
  async deletePreset(projectId: string, id: string) {
    const record = await this.read<MergePreset>("presets", id);
    if (record.projectId !== projectId)
      throw new GitMrError("Preset not found.", "NOT_FOUND", 404);
    await fs.unlink(this.filename("presets", id));
  }
  async proposals(projectId: string, mrId: string) {
    return (
      await this.list<MergeProposal & { projectId: string }>(
        "proposals",
        projectId,
      )
    ).filter((item) => item.mrId === mrId);
  }
  /** Cross-process exclusive lock. Never steal a lock after a timeout: a child may still be writing. */
  async operationActive(identity: string) {
    const dir = path.join(
      this.directory,
      "locks",
      createHash("sha256").update(identity).digest("hex"),
    );
    try {
      const owner = JSON.parse(
        await fs.readFile(path.join(dir, "owner.json"), "utf8"),
      ) as { pid: number };
      if (!Number.isInteger(owner.pid) || owner.pid <= 0) return true;
      try {
        process.kill(owner.pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return await fs.stat(dir).then(
          () => true,
          () => false,
        );
      return true;
    }
  }
  private async reclaimStoppedOwner(dir: string) {
    const busy = () =>
      new GitMrError(
        "Repository is busy. An interrupted operation can resume once all owned processes have exited.",
        "REPOSITORY_BUSY",
      );
    const alive = (pid: number) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code !== "ESRCH";
      }
    };
    const guard = dir + ".recovery";
    try {
      await fs.mkdir(guard);
    } catch {
      throw busy();
    }
    try {
      const owner = JSON.parse(
        await fs.readFile(path.join(dir, "owner.json"), "utf8"),
      ) as { pid: number; hostId: string };
      if (!Number.isInteger(owner.pid) || owner.pid <= 0 || alive(owner.pid))
        throw busy();
      const processes = getRawSqlite()
        .prepare(
          "SELECT pid, runtime_pid, state FROM agent_runtime_processes WHERE host_id = ? AND state != 'exited'",
        )
        .all(owner.hostId ?? `local:${owner.pid}`) as {
        pid: number | null;
        runtime_pid: number | null;
        state: string;
      }[];
      if (
        processes.some(
          (child) => child.runtime_pid || (child.pid && alive(child.pid)),
        )
      )
        throw busy();
      // Move the abandoned directory, never remove a newly acquired lock at the same path.
      const abandoned = dir + ".abandoned." + randomUUID();
      await fs.rename(dir, abandoned);
      await fs.rm(abandoned, { recursive: true, force: true });
    } catch (error) {
      if (error instanceof GitMrError) throw error;
      throw busy();
    } finally {
      await fs.rm(guard, { recursive: true, force: true });
    }
  }
  async exclusive<T>(identity: string, action: () => Promise<T>): Promise<T> {
    const dir = path.join(
      this.directory,
      "locks",
      createHash("sha256").update(identity).digest("hex"),
    );
    await fs.mkdir(path.dirname(dir), { recursive: true });
    try {
      await fs.mkdir(dir);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      await this.reclaimStoppedOwner(dir);
      try {
        await fs.mkdir(dir);
      } catch {
        throw new GitMrError("Repository is busy.", "REPOSITORY_BUSY");
      }
    }
    try {
      await fs.writeFile(
        path.join(dir, "owner.json"),
        JSON.stringify({
          pid: process.pid,
          hostId: process.env.SYNAX_RUNTIME_HOST_ID ?? `local:${process.pid}`,
          at: new Date().toISOString(),
        }),
      );
      return await action();
    } finally {
      await fs.rm(dir, { recursive: true, force: true });
    }
  }
}
export const gitMrStore = new GitMrStore();
