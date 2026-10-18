import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { getGlobalConfig } from "../runtime/config/config-store.js";
import { systemTerminalShell } from "./terminal-shell.js";
import path from "node:path";
import type { IPty } from "node-pty";
import { assertRuntimeExecutionCurrent } from "../runtime/execution-context.js";
import { withoutExecutionContext } from "../runtime/execution-context.js";
import { canonicalWorkspaceDirectory } from "../../modules/project-workspace.js";
import {
  externalCommandEnvironment,
  prepareOwnedProcess,
  recordOwnedPid,
  recordOwnedRuntime,
  recordOwnedRuntimeTarget,
  readProcessIdentity,
  releaseOwnedProcess,
  waitForAuthoritativeLease,
  stopRecordedProcess,
  type OwnedProcessRecord,
} from "../../modules/agent-runtime/process-ownership.js";
import { AgentRuntimeError } from "../../modules/agent-runtime/runtime-errors.js";
import { parseWslUncPath } from "../../modules/workspace-location.js";
import {
  findWslOwnedProcess,
  wslCommandSpec,
  wslLauncherEnvironment,
} from "../wsl/wsl.js";

const MAX_OUTPUT = 2 * 1024 * 1024;
const MAX_LIVE = 16;
const AUTHORITATIVE_FLUSH_INTERVAL_MS = 250;
// Keep the serialized terminal snapshot comfortably below the 1 MiB private
// sidecar frame budget. The live PTY may retain more output in memory; Rust
// history receives a bounded replay tail on every flush.
const AUTHORITATIVE_OUTPUT_LIMIT = 128 * 1024;
const execFileAsync = promisify(execFile);
export interface TerminalInfo {
  id: string;
  projectId: string;
  rootId: string;
  ownerSessionId: string | null;
  kind: "terminal" | "service";
  title: string;
  cwd: string;
  shell: string;
  command: string | null;
  pid: number | null;
  state: string;
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
  cols: number;
  rows: number;
  requestKey?: string;
  processIdentity?: string;
  deletedAt?: string;
}
export interface TerminalFrame {
  sequence: number;
  data: string;
  offset?: number;
}
export type TerminalEvent =
  | { type: "output"; frame: TerminalFrame }
  | { type: "state"; terminal: TerminalInfo };
interface LiveTerminal {
  info: TerminalInfo;
  runtimeKind?: "wsl";
  runtimeDistribution?: string;
  pty: IPty;
  frames: TerminalFrame[];
  size: number;
  sequence: number;
  dirty: boolean;
  listeners: Set<(event: TerminalEvent) => void>;
  inputs: Map<string, string>;
  stopping: boolean;
  written: number;
  clients: Map<string, { offset: number }>;
  paused: boolean;
  exited: Promise<void>;
  finish: () => void;
  closed: boolean;
  identityReady: Promise<void>;
  authoritativePersisting?: Promise<void>;
  authoritativeFlushQueued: boolean;
}
function failure(message: string, status = 409): never {
  throw new AgentRuntimeError(message, "TERMINAL_ERROR", status);
}
function dimensions(cols: number, rows: number) {
  if (
    !Number.isInteger(cols) ||
    !Number.isInteger(rows) ||
    cols < 2 ||
    cols > 500 ||
    rows < 1 ||
    rows > 300
  )
    failure("Invalid terminal dimensions.", 400);
}
class TerminalManager {
  private live = new Map<string, LiveTerminal>();
  private readonly authoritativeHistory = new Map<string, TerminalInfo>();
  private readonly authoritativeOutput = new Map<string, { sequence: number; data: string }>();
  private readonly authoritativeHydratedProjects = new Set<string>();
  private readonly authoritativeHydration = new Map<string, Promise<void>>();

  private authoritativeEnabled(): boolean {
    return true;
  }

  private mergeAuthoritativeRecord(raw: unknown): string | undefined {
    if (!raw || typeof raw !== "object") return undefined;
    const record = raw as Record<string, unknown>;
    if(record.deletedAt && typeof record.id==='string') {this.authoritativeHistory.delete(record.id);return;}
    const required = ["id", "projectId", "rootId", "kind", "title", "cwd", "shell", "state", "startedAt"];
    if (required.some((key) => typeof record[key] !== "string")) return undefined;
    if (record.ownerSessionId !== null && record.ownerSessionId !== undefined && typeof record.ownerSessionId !== "string") return undefined;
    if (record.command !== null && record.command !== undefined && typeof record.command !== "string") return undefined;
    const item: TerminalInfo = {
      id: record.id as string,
      projectId: record.projectId as string,
      rootId: record.rootId as string,
      ownerSessionId: (record.ownerSessionId as string | null | undefined) ?? null,
      kind: record.kind === "service" ? "service" : "terminal",
      title: record.title as string,
      cwd: record.cwd as string,
      shell: record.shell as string,
      command: (record.command as string | null | undefined) ?? null,
      pid: typeof record.pid === "number" ? record.pid : null,
      state: record.state as string,
      exitCode: typeof record.exitCode === "number" ? record.exitCode : null,
      startedAt: record.startedAt as string,
      endedAt: typeof record.endedAt === "string" ? record.endedAt : null,
      cols: typeof record.cols === "number" ? record.cols : 100,
      rows: typeof record.rows === "number" ? record.rows : 30,
      requestKey: typeof record.requestKey === "string" ? record.requestKey:undefined,
      processIdentity: typeof record.processIdentity === "string" ? record.processIdentity:undefined,
    };
    this.authoritativeHistory.set(item.id, item);
    const outputSequence = record.outputSequence;
    const outputTail = record.outputTail;
    if (typeof outputSequence === "number" && Number.isSafeInteger(outputSequence) && outputSequence >= 0 && typeof outputTail === "string")
      this.authoritativeOutput.set(item.id, {
        sequence: outputSequence,
        data: outputTail.length > MAX_OUTPUT ? outputTail.slice(-MAX_OUTPUT) : outputTail,
      });
    return item.id;
  }

  private async hydrateAuthoritativeProject(projectId: string): Promise<void> {
    if (!this.authoritativeEnabled() || this.authoritativeHydratedProjects.has(projectId)) return;
    const pending = this.authoritativeHydration.get(projectId);
    if (pending) return pending;
    const hydration = (async () => {
      if (!process.env.SYNAX_RUNTIME_SIDECAR_SOCKET || !process.env.SYNAX_RUNTIME_SIDECAR_TOKEN) {
        this.authoritativeHydratedProjects.add(projectId);
        return;
      }
      const { runtimeFacade } = await import("../../modules/agent-runtime/sidecar/runtime-facade.js");
      const records = await runtimeFacade.listTerminalHistory(projectId);
      for (const raw of records) this.mergeAuthoritativeRecord(raw);
      this.authoritativeHydratedProjects.add(projectId);
    })();
    this.authoritativeHydration.set(projectId, hydration);
    try {
      await hydration;
    } finally {
      this.authoritativeHydration.delete(projectId);
    }
  }

  async hydrateAuthoritative(projectId: string): Promise<void> {
    await this.hydrateAuthoritativeProject(projectId);
  }

  async getAuthoritative(id: string, projectId?: string): Promise<TerminalInfo> {

    const live = this.live.get(id)?.info;
    const cached = live ?? this.authoritativeHistory.get(id);
    if (cached && (!projectId || cached.projectId === projectId)) return { ...cached };
    if (projectId) await this.hydrateAuthoritativeProject(projectId);
    const item = this.live.get(id)?.info ?? this.authoritativeHistory.get(id);
    if (!item || (projectId && item.projectId !== projectId)) failure("Terminal not found.", 404);
    return { ...item };
  }

  async snapshotAuthoritative(id: string, projectId?: string): Promise<{ sequence: number; data: string }> {

    if (!this.live.has(id) && !this.authoritativeHistory.has(id) && projectId)
      await this.hydrateAuthoritativeProject(projectId);
    const entry = this.live.get(id);
    if (entry) return { sequence: entry.sequence, data: entry.frames.map((frame) => frame.data).join("") };
    if (!this.authoritativeHistory.has(id)) failure("Terminal not found.", 404);
    return this.authoritativeOutput.get(id) ?? { sequence: 0, data: "" };
  }

  async replayAuthoritative(id: string, projectId?: string, after?: number): Promise<{ reset: boolean; sequence: number; frames: TerminalFrame[] }> {

    const entry = this.live.get(id);
    const snapshot = await this.snapshotAuthoritative(id, projectId);
    if (after !== undefined && after === snapshot.sequence) return { reset: false, sequence: after, frames: [] };
    if (entry && after !== undefined && after >= (entry.frames[0]?.sequence ?? 1) - 1 && after <= entry.sequence)
      return { reset: false, sequence: entry.sequence, frames: entry.frames.filter((frame) => frame.sequence > after) };
    return { reset: true, sequence: snapshot.sequence, frames: [{ sequence: snapshot.sequence, data: snapshot.data }] };
  }

  private boundedAuthoritativeOutput(data: string): string {
    const bytes = Buffer.from(data);
    if (bytes.length <= AUTHORITATIVE_OUTPUT_LIMIT) return data;
    return bytes.subarray(-AUTHORITATIVE_OUTPUT_LIMIT).toString("utf8");
  }

  private authoritativeSnapshot(entry: LiveTerminal): {
    info: TerminalInfo;
    output: { sequence: number; data: string };
  } {
    return {
      info: { ...entry.info },
      output: {
        sequence: entry.sequence,
        data: this.boundedAuthoritativeOutput(
          entry.frames.map((frame) => frame.data).join(""),
        ),
      },
    };
  }

  private async persistAuthoritative(
    info: TerminalInfo,
    output = this.authoritativeOutput.get(info.id) ?? { sequence: 0, data: "" },
  ): Promise<void> {

    if (!process.env.SYNAX_RUNTIME_SIDECAR_SOCKET || !process.env.SYNAX_RUNTIME_SIDECAR_TOKEN) {
      this.authoritativeHistory.set(info.id, { ...info });
      this.authoritativeOutput.set(info.id, { ...output });
      return;
    }
    const { runtimeFacade } = await import("../../modules/agent-runtime/sidecar/runtime-facade.js");
    const scopeId = `terminals:${info.projectId}`;
    const value = {
      ...info,
      outputTail: output.data,
      outputSequence: output.sequence,
      sessionId: scopeId,
    };
    // The existing RuntimeFacade helper intentionally keeps a stable request
    // id for a terminal finish. Streaming snapshots need a new id per content
    // version, otherwise history correctly rejects a changed payload as a
    // request conflict. The content hash keeps retries idempotent.
    const digest = createHash("sha256")
      .update(JSON.stringify(value))
      .digest("hex");
    await runtimeFacade.historyCommandGlobal({
      scopeId,
      requestId: `terminal:${info.id}:${output.sequence}:${digest}`,
      operation: "append_entities",
      payload: { objects: [{ kind: "runtime.terminal", value }] },
    });
    this.authoritativeHistory.set(info.id, { ...info });
    this.authoritativeOutput.set(info.id, { ...output });
    this.authoritativeHydratedProjects.add(info.projectId);
  }

  private queueAuthoritativeFlush(entry: LiveTerminal): void {
    if (!this.authoritativeEnabled() || !entry.dirty) return;
    entry.authoritativeFlushQueued = true;
    if (entry.authoritativePersisting) return;
    entry.authoritativePersisting = (async () => {
      while (entry.authoritativeFlushQueued) {
        entry.authoritativeFlushQueued = false;
        const snapshot = this.authoritativeSnapshot(entry);
        try {
          await this.persistAuthoritative(snapshot.info, snapshot.output);
          if (
            entry.sequence === snapshot.output.sequence &&
            entry.info.state === snapshot.info.state &&
            entry.info.endedAt === snapshot.info.endedAt &&
            entry.info.cols === snapshot.info.cols &&
            entry.info.rows === snapshot.info.rows
          ) {
            entry.dirty = false;
          } else {
            entry.authoritativeFlushQueued = true;
          }
        } catch {
          // Keep dirty so the bounded timer retries after a sidecar restart.
          entry.dirty = true;
          return;
        }
      }
    })().finally(() => {
      entry.authoritativePersisting = undefined;
      if (
        entry.closed &&
        !entry.dirty &&
        this.live.get(entry.info.id) === entry
      ) {
        this.live.delete(entry.info.id);
      }
    });
  }
  private flushTimer?: ReturnType<typeof setInterval>;
  private stopping = new Map<string, Promise<void>>();
  get(id: string, projectId?: string): TerminalInfo {
    {
      const item = this.live.get(id)?.info ?? this.authoritativeHistory.get(id);
      if (!item || (projectId && item.projectId !== projectId)) failure("Terminal not found.", 404);
      return { ...item };
    }
  }
  list(projectId: string): TerminalInfo[] {
    {
      const items = new Map<string, TerminalInfo>(this.authoritativeHistory);
      for (const entry of this.live.values()) items.set(entry.info.id, entry.info);
      return [...items.values()]
        .filter((item) => item.projectId === projectId)
        .sort((a, b) => Number(b.state !== "closed") - Number(a.state !== "closed") || b.startedAt.localeCompare(a.startedAt))
        .slice(0, 100)
        .map((item) => ({ ...item }));
    }
  }
  async listAuthoritative(projectId: string): Promise<TerminalInfo[]> {

    await this.hydrateAuthoritativeProject(projectId);
    return this.list(projectId);
  }
  has(id: string): boolean {
    return this.live.has(id) || this.authoritativeHistory.has(id);
  }
  async create(input: {
    projectId: string;
    rootId: string;
    ownerSessionId?: string;
    cwd: string;
    kind: "terminal" | "service";
    title: string;
    command?: string;
    env?: NodeJS.ProcessEnv;
    cols?: number;
    rows?: number;
    shell?: string;
    shellArgs?: string[];
    requestKey?: string;
    stdin?: string;
  }): Promise<TerminalInfo> {

    if (
      [...this.live.values()].filter((value) => !value.closed).length >=
      MAX_LIVE
    )
      failure(
        "Too many running terminals. Stop an unused terminal first.",
        429,
      );
    const cwd = canonicalWorkspaceDirectory(input.cwd);
    const cols = input.cols ?? 100,
      rows = input.rows ?? 30;
    dimensions(cols, rows);
    const wsl = parseWslUncPath(cwd);
    const shell = wsl
      ? "/bin/sh"
      : (input.shell ??
          (input.kind === "terminal"
            ? getGlobalConfig().terminalShellPath
            : undefined)) ||
        systemTerminalShell();
    const { spawn } = await import("node-pty");
    // Recheck after loading the native module; no process is spawned before the record is committed.
    if (input.requestKey) {
      await this.hydrateAuthoritativeProject(input.projectId);
      const found = this.list(input.projectId).find(t=>t.requestKey===input.requestKey);
      if (found) return this.get(found.id, input.projectId);
    }
    if (
      [...this.live.values()].filter((value) => !value.closed).length >=
      MAX_LIVE
    )
      failure("Too many running terminals.", 429);
    const ticket = prepareOwnedProcess(
      input.command ?? input.title,
      process.platform !== "win32" || Boolean(wsl),
      { sessionId: input.ownerSessionId, background: input.kind === "service" },
    );
    await waitForAuthoritativeLease(ticket.id);
    if (wsl) recordOwnedRuntimeTarget(ticket.id, wsl.distribution);
    let identityReadyResolve: (() => void) | undefined;
    try {


      const localArgs =
        input.shellArgs ??
        (input.kind === "service"
          ? process.platform === "win32"
            ? ["/d", "/s", "/c", input.command ?? ""]
            : ["-lc", input.command ?? ""]
          : process.platform === "win32"
            ? []
            : ["-l"]);
      const target = wsl
        ? wslCommandSpec(
            wsl.distribution,
            wsl.path,
            input.kind === "service" ? (input.command ?? "") : shell,
            input.kind === "service" ? [] : ["-l"],
            { shell: input.kind === "service", ownerId: ticket.id },
          )
        : { command: shell, args: localArgs };
      const env: NodeJS.ProcessEnv = {
        ...(wsl
          ? wslLauncherEnvironment(input.env)
          : externalCommandEnvironment(input.env)),
        SYNAX_PROCESS_OWNER: ticket.id,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      };
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.SYNAX_TERMINAL_HOST_ORIGIN;
      // API listener/runtime flags are not a user's shell environment.
      for (const key of ["PORT", "NODE_ENV"])
        if (input.env?.[key] === undefined) delete env[key];
      const pty = spawn(target.command, target.args, {
        cwd: wsl ? undefined : cwd,
        env: Object.fromEntries(
          Object.entries(env).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        ),
        cols,
        rows,
        name: "xterm-256color",
      });
      let finish!: () => void;
      const entry: LiveTerminal = {
        info: {
          id: ticket.id,
          projectId: input.projectId,
          rootId: input.rootId,
          ownerSessionId: input.ownerSessionId ?? null,
          kind: input.kind,
          title: input.title,
          cwd,
          shell,
          command: input.command ?? null,
          pid: pty.pid,
          requestKey: input.requestKey,
          state: "active",
          exitCode: null,
          startedAt: new Date().toISOString(),
          endedAt: null,
          cols,
          rows,
        },
        ...(wsl ? { runtimeKind: "wsl" as const, runtimeDistribution: wsl.distribution } : {}),
        pty,
        frames: [],
        size: 0,
        sequence: 0,
        dirty: false,
        listeners: new Set(),
        inputs: new Map(),
        stopping: false,
        written: 0,
        clients: new Map(),
        paused: false,
        closed: false,
        authoritativeFlushQueued: false,
        identityReady: new Promise<void>((resolve) => {
          identityReadyResolve = resolve;
        }),
        exited: new Promise((resolve) => {
          finish = resolve;
        }),
        finish: () => finish(),
      };
      this.live.set(ticket.id, entry);
      recordOwnedPid(ticket.id, pty.pid);
      if (wsl) {
        void (async () => {
          for (let attempt = 0; attempt < 20 && !entry.closed; attempt += 1) {
            const owned = await findWslOwnedProcess(
              wsl.distribution,
              ticket.id,
            );
            if (owned) {
              recordOwnedRuntime(ticket.id, {
                kind: "wsl",
                distribution: wsl.distribution,
                ...owned,
              });
              return;
            }
            await new Promise((resolve) => setTimeout(resolve, 50));
          }
        })();
      }
      pty.onData((data) =>
        withoutExecutionContext(() => {
          const frame = {
            sequence: ++entry.sequence,
            data,
            offset: (entry.written += data.length),
          };
          entry.frames.push(frame);
          entry.size += data.length * 2;
          entry.dirty = true;
          while (
            (entry.size > MAX_OUTPUT || entry.frames.length > 4096) &&
            entry.frames.length > 1
          )
            entry.size -= entry.frames.shift()!.data.length * 2;
          if (entry.frames.length === 1 && entry.size > MAX_OUTPUT) {
            entry.frames[0].data = data.slice(-MAX_OUTPUT / 2);
            entry.size = MAX_OUTPUT;
          }
          for (const listener of entry.listeners)
            listener({ type: "output", frame });
          this.flow(entry);
        }),
      );
      pty.onExit(({ exitCode, signal }) =>
        withoutExecutionContext(() => {
          entry.closed = true;
          entry.info.state = "closed";
          entry.info.exitCode = entry.stopping || signal ? null : exitCode;
          entry.info.endedAt = new Date().toISOString();
          entry.dirty = true;
          this.authoritativeOutput.set(ticket.id, { sequence: entry.sequence, data: entry.frames.map((frame) => frame.data).join("") });
          releaseOwnedProcess(
            ticket.id,
            entry.stopping || signal ? null : exitCode,
          );
          this.flush(ticket.id, entry);
          this.authoritativeHistory.set(ticket.id, { ...entry.info });
          const terminal = this.has(ticket.id) ? this.get(ticket.id) : { ...entry.info };
          if (terminal)
            for (const listener of entry.listeners)
              listener({ type: "state", terminal });
          entry.finish();
          // Keep a closed terminal in the live map until its authoritative
          // snapshot is durably accepted. A sidecar restart must leave the
          // dirty entry eligible for the retry timer.

        }),
      );
      // node-pty 1.1 exposes the slave path on its Unix handle. It is only
      // read for ownership validation; if unavailable, do not invent an identity.
      const tty = (pty as IPty & { _pty?: unknown })._pty;
      try {
        if (typeof tty === "string" && tty.startsWith("/dev/")) {
          // posix_spawn can return before the child acquires its controlling TTY.
          for (let attempt = 0; attempt < 25 && !entry.closed; attempt++) {
            const identity = await readProcessIdentity(pty.pid, tty);
            if (identity && !entry.closed) {
              entry.info.processIdentity = identity;
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        }
      } finally {
        identityReadyResolve?.();
      }
      await assertRuntimeExecutionCurrent();
      if (input.stdin) pty.write(input.stdin);
      if (!this.flushTimer) {
        this.flushTimer = setInterval(
          () =>
            withoutExecutionContext(() => {
              for (const [id, value] of this.live)
                if (value.dirty) this.flush(id, value);
            }),
          AUTHORITATIVE_FLUSH_INTERVAL_MS,
        );
        this.flushTimer.unref();
      }
      {
        const snapshot = this.authoritativeSnapshot(entry);
        await this.persistAuthoritative(snapshot.info, snapshot.output);
        entry.dirty = false;
        return { ...entry.info };
      }
    } catch (error) {
      identityReadyResolve?.();
      if (this.live.has(ticket.id))
        await withoutExecutionContext(() => this.stop(ticket.id));
      else releaseOwnedProcess(ticket.id, 1);
      throw error;
    }
  }
  private flush(id: string, entry: LiveTerminal) {
    if (!entry.dirty) return;
    {
      this.queueAuthoritativeFlush(entry);
      return;
    }
  }
  snapshot(id: string): { sequence: number; data: string } {
    const entry = this.live.get(id);
    if (entry)
      return {
        sequence: entry.sequence,
        data: entry.frames.map((frame) => frame.data).join(""),
      };
    return this.authoritativeOutput.get(id) ?? { sequence: 0, data: "" };
  }
  replay(
    id: string,
    after?: number,
  ): { reset: boolean; sequence: number; frames: TerminalFrame[] } {
    const entry = this.live.get(id);
    const snapshot = this.snapshot(id);
    if (after !== undefined && after === snapshot.sequence)
      return { reset: false, sequence: after, frames: [] };
    if (
      entry &&
      after !== undefined &&
      after >= (entry.frames[0]?.sequence ?? 1) - 1 &&
      after <= entry.sequence
    )
      return {
        reset: false,
        sequence: entry.sequence,
        frames: entry.frames.filter((frame) => frame.sequence > after),
      };
    return {
      reset: true,
      sequence: snapshot.sequence,
      frames: [{ sequence: snapshot.sequence, data: snapshot.data }],
    };
  }
  subscribe(id: string, listener: (event: TerminalEvent) => void): () => void {
    this.get(id);
    const entry = this.live.get(id);
    entry?.listeners.add(listener);
    return () => entry?.listeners.delete(listener);
  }
  connectReader(id: string, clientId: string): () => void {
    const entry = this.live.get(id);
    if (!entry) return () => {};
    if (entry.clients.size >= 8 && !entry.clients.has(clientId))
      failure("Too many terminal readers.", 429);
    const reader = { offset: entry.written };
    entry.clients.set(clientId, reader);
    return () => {
      if (entry.clients.get(clientId) === reader)
        entry.clients.delete(clientId);
      this.flow(entry);
    };
  }
  acknowledge(id: string, clientId: string, sequence: number): void {
    const entry = this.live.get(id);
    if (!entry || !entry.clients.has(clientId)) return;
    const offset =
      sequence === entry.sequence
        ? entry.written
        : entry.frames.find((frame) => frame.sequence === sequence)?.offset;
    if (offset !== undefined)
      entry.clients.get(clientId)!.offset = Math.max(
        entry.clients.get(clientId)!.offset,
        offset,
      );
    this.flow(entry);
  }
  private flow(entry: LiveTerminal) {
    if (entry.closed) return;
    const oldest = entry.clients.size
      ? Math.min(...[...entry.clients.values()].map((reader) => reader.offset))
      : entry.written;
    const pause = entry.written - oldest > 256 * 1024;
    if (pause === entry.paused) return;
    entry.paused = pause;
    if (pause) entry.pty.pause();
    else entry.pty.resume();
  }
  write(id: string, data: string, requestId: string, binary = false): void {
    const entry = this.live.get(id);
    if (!entry || entry.closed || entry.stopping)
      failure("This terminal has ended. Open a new terminal.");
    if (!data || data.length > 65536 || !/^[\w:-]{8,128}$/.test(requestId))
      failure("Invalid terminal input.", 400);
    const hash = createHash("sha256").update(`${binary}:${data}`).digest("hex");
    const previous = entry.inputs.get(requestId);
    if (previous) {
      if (previous !== hash)
        failure("Input request ID was reused with different data.", 400);
      return;
    }
    entry.pty.write(binary ? Buffer.from(data, "binary") : data);
    entry.inputs.set(requestId, hash);
    if (entry.inputs.size > 256)
      entry.inputs.delete(entry.inputs.keys().next().value!);
  }
  resize(id: string, cols: number, rows: number): void {
    dimensions(cols, rows);
    const entry = this.live.get(id);
    if (!entry || entry.closed) return;
    entry.pty.resize(cols, rows);
    entry.info.cols = cols;
    entry.info.rows = rows;
    entry.dirty = true;

  }
  redraw(id: string): void {
    const entry = this.live.get(id);
    if (!entry || entry.closed) return;
    const { cols, rows } = entry.pty;
    entry.pty.resize(cols, rows === 300 ? 299 : rows + 1);
    entry.pty.resize(cols, rows);
  }
  stop(id: string): Promise<void> {
    const existing = this.stopping.get(id);
    if (existing) return existing;
    const pending = this.stopTree(id).finally(() => this.stopping.delete(id));
    this.stopping.set(id, pending);
    return pending;
  }
  private async stopTree(id: string): Promise<void> {
    const entry = this.live.get(id);
    if (entry) {
      entry.stopping = true;
      await entry.identityReady;
    }
    if (process.env.SYNAX_RUNTIME_SIDECAR_STREAM === "authoritative" && entry && !entry.closed) {
      entry.pty.kill();
      const exited = await Promise.race([
        entry.exited.then(() => true),
        new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5000)),
      ]);
      if (!exited) {
        entry.stopping = false;
        failure("Unable to confirm terminal shutdown. Retry before deleting the record.");
      }
      return;
    }
    const record:OwnedProcessRecord = process.env.SYNAX_RUNTIME_SIDECAR_STREAM === "authoritative" && entry
      ? {
          id,
          host_id: process.env.SYNAX_RUNTIME_HOST_ID ?? `local:${process.pid}`,
          session_id: entry.info.ownerSessionId,
          run_id: null,
          pid: entry.info.pid,
          process_group: process.platform !== "win32" ? 1 : 0,
          state: entry.info.state,
          command_label: entry.info.title,
          ...(entry.runtimeKind === "wsl" ? { runtime_kind: "wsl" as const, runtime_distribution: entry.runtimeDistribution } : {}),
        } as OwnedProcessRecord
      : (() => {
          const info=this.get(id);
          return {id,host_id:'recovered',session_id:info.ownerSessionId,run_id:null,pid:info.pid,process_group:1,state:info.state,command_label:info.command ?? info.title,process_identity:info.processIdentity} satisfies OwnedProcessRecord;
        })();
    if (record.runtime_kind === "wsl") {
      if (!(await stopRecordedProcess(record))) {
        entry && (entry.stopping = false);
        failure(
          "Unable to confirm WSL terminal shutdown. Retry before deleting the record.",
        );
      }
      if (entry && !entry.closed) entry.pty.kill();
      return;
    }
    if (process.platform === "win32" && entry && !entry.closed) {
      // ConPTY owns native process handles; never guess ownership from a reused PID.
      entry.pty.kill();
      let timer: ReturnType<typeof setTimeout> | undefined;
      const exited = await Promise.race([
        entry.exited.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 5000);
        }),
      ]);
      clearTimeout(timer);
      if (!exited) {

        entry.stopping = false;
        failure(
          "Unable to confirm terminal shutdown. Retry before deleting the record.",
        );
      }
      return;
    }
    // Interactive shells put foreground jobs into distinct groups. Capture descendants
    // before stopping the shell, and verify the ownership nonce before every signal.
    if (record.pid && process.platform !== "win32") {
      try {
        const { stdout } = await execFileAsync(
          "/bin/ps",
          ["-axo", "pid=,ppid="],
          { timeout: 3000, maxBuffer: 2 * 1024 * 1024 },
        );
        const rows = stdout
          .trim()
          .split("\n")
          .map((line) => line.trim().split(/\s+/).map(Number));
        const descendants = new Set<number>([record.pid]);
        for (let count = 0; count < rows.length; count++) {
          const oldSize = descendants.size;
          for (const [pid, parent] of rows)
            if (descendants.has(parent)) descendants.add(pid);
          if (oldSize === descendants.size) break;
        }
        for (const pid of [...descendants].reverse())
          if (pid !== record.pid)
            await stopRecordedProcess({ ...record, pid, process_group: 0 });
      } catch {
        /* The verified group stop below remains the fallback. */
      }
    }
    const confirmed = await stopRecordedProcess(record);
    if (!confirmed) {

      if (entry) entry.stopping = false;
      failure(
        "Unable to confirm terminal shutdown. The record has been kept for retry.",
      );
    }
    if (entry) {
      // stopRecordedProcess may report a recycled PID as already gone. Never
      // follow that result with an unverified PID signal through IPty.kill().
      let timer: ReturnType<typeof setTimeout> | undefined;
      const exited = await Promise.race([
        entry.exited.then(() => true),
        new Promise<boolean>((resolve) => {
          timer = setTimeout(() => resolve(false), 2000);
        }),
      ]);
      clearTimeout(timer);
      if (!exited) {
        entry.stopping = false;

        failure(
          "Terminal exit could not be confirmed. The process and its record were retained.",
        );
      }
      this.flush(id, entry);
    }
  }
  async remove(id: string): Promise<void> {
    {
      const item = this.live.get(id)?.info ?? this.authoritativeHistory.get(id);
      if (!item || item.state !== "closed" || (this.live.has(id) && !this.live.get(id)!.closed))
        failure("Stop this terminal before deleting its record.");
      await this.persistAuthoritative({...item,deletedAt:new Date().toISOString()});
      this.live.delete(id);
      this.authoritativeHistory.delete(id);
      return;
    }
  }
  async shutdown(): Promise<void> {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = undefined;
    const results = await Promise.allSettled(
      [...this.live.keys()].map((id) => this.stop(id)),
    );
    if (results.some((result) => result.status === "rejected"))
      failure("Some terminal processes could not be stopped.");
  }
}
export const terminalManager = new TerminalManager();
