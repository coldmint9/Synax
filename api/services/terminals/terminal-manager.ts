import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import type { IPty } from "node-pty";
import { getRawSqlite, assertRuntimeExecutionCurrent } from "../../db/index.js";
import { withoutExecutionContext } from "../../lib/execution-context.js";
import { canonicalWorkspaceDirectory } from "../project-workspace.js";
import {
  externalCommandEnvironment,
  prepareOwnedProcess,
  recordOwnedPid,
  readProcessIdentity,
  releaseOwnedProcess,
  stopRecordedProcess,
  type OwnedProcessRecord,
} from "../agent-runtime/process-ownership.js";
import { AgentRuntimeError } from "../agent-runtime/runtime-errors.js";

const MAX_OUTPUT = 2 * 1024 * 1024;
const MAX_LIVE = 16;
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
}
interface TerminalRow extends OwnedProcessRecord {
  project_id: string;
  root_id: string;
  owner_session_id: string | null;
  terminal_kind: "terminal" | "service";
  title: string;
  cwd: string;
  shell: string;
  command: string | null;
  cols: number;
  rows: number;
  output_sequence: number;
}
const rowQuery = `SELECT p.*, t.project_id, t.root_id, t.owner_session_id, t.kind AS terminal_kind,
 t.title, t.cwd, t.shell, t.command, t.cols, t.rows, t.output_sequence
 FROM terminal_sessions t JOIN agent_runtime_processes p ON p.id=t.id`;
function info(row: TerminalRow): TerminalInfo {
  return {
    id: row.id,
    projectId: row.project_id,
    rootId: row.root_id,
    ownerSessionId: row.owner_session_id,
    kind: row.terminal_kind,
    title: row.title,
    cwd: row.cwd,
    shell: row.shell,
    command: row.command,
    pid: row.pid,
    state: row.state,
    exitCode: row.exit_code ?? null,
    startedAt: row.started_at!,
    endedAt: row.ended_at ?? null,
    cols: row.cols,
    rows: row.rows,
  };
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
function defaultShell(): string {
  if (process.platform === "win32") return process.env.COMSPEC || "cmd.exe";
  return process.env.SHELL || os.userInfo().shell || "/bin/sh";
}

class TerminalManager {
  private live = new Map<string, LiveTerminal>();
  private flushTimer?: ReturnType<typeof setInterval>;
  private stopping = new Map<string, Promise<void>>();
  private row(id: string): TerminalRow {
    const row = getRawSqlite().prepare(`${rowQuery} WHERE t.id=?`).get(id) as
      | TerminalRow
      | undefined;
    if (!row) failure("Terminal not found.", 404);
    return row;
  }
  get(id: string, projectId?: string): TerminalInfo {
    const row = this.row(id);
    if (projectId && row.project_id !== projectId)
      failure("Terminal not found in this project.", 404);
    return info(row);
  }
  list(projectId: string): TerminalInfo[] {
    return (
      getRawSqlite()
        .prepare(
          `${rowQuery} WHERE t.project_id=? ORDER BY (p.state<>'closed') DESC, p.started_at DESC LIMIT 100`,
        )
        .all(projectId) as TerminalRow[]
    ).map(info);
  }
  has(id: string): boolean {
    return Boolean(
      getRawSqlite()
        .prepare("SELECT id FROM terminal_sessions WHERE id=?")
        .get(id),
    );
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
    if (input.requestKey) {
      const found = getRawSqlite()
        .prepare("SELECT id FROM terminal_sessions WHERE request_key=?")
        .get(input.requestKey) as { id: string } | undefined;
      if (found) return this.get(found.id, input.projectId);
    }
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
    const shell = input.shell ?? defaultShell();
    const { spawn } = await import("node-pty");
    // Recheck after loading the native module; no process is spawned before the record is committed.
    if (input.requestKey) {
      const found = getRawSqlite()
        .prepare("SELECT id FROM terminal_sessions WHERE request_key=?")
        .get(input.requestKey) as { id: string } | undefined;
      if (found) return this.get(found.id, input.projectId);
    }
    if (
      [...this.live.values()].filter((value) => !value.closed).length >=
      MAX_LIVE
    )
      failure("Too many running terminals.", 429);
    const ticket = prepareOwnedProcess(
      input.command ?? input.title,
      process.platform !== "win32",
      { sessionId: input.ownerSessionId, background: input.kind === "service" },
    );
    const db = getRawSqlite();
    let identityReadyResolve: (() => void) | undefined;
    try {
      if (input.kind === "terminal")
        db.prepare(
          "UPDATE agent_runtime_processes SET kind='terminal' WHERE id=?",
        ).run(ticket.id);
      db.prepare(
        `INSERT INTO terminal_sessions (id,project_id,root_id,owner_session_id,kind,title,cwd,shell,command,cols,rows,request_key) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
      ).run(
        ticket.id,
        input.projectId,
        input.rootId,
        input.ownerSessionId ?? null,
        input.kind,
        input.title,
        cwd,
        shell,
        input.command ?? null,
        cols,
        rows,
        input.requestKey ?? null,
      );
      const args =
        input.shellArgs ??
        (input.kind === "service"
          ? process.platform === "win32"
            ? ["/d", "/s", "/c", input.command ?? ""]
            : ["-lc", input.command ?? ""]
          : process.platform === "win32"
            ? []
            : ["-l"]);
      const env: NodeJS.ProcessEnv = {
        ...externalCommandEnvironment(input.env),
        SYNAX_PROCESS_OWNER: ticket.id,
        TERM: "xterm-256color",
        COLORTERM: "truecolor",
      };
      delete env.ELECTRON_RUN_AS_NODE;
      delete env.SYNAX_TERMINAL_HOST_ORIGIN;
      // API listener/runtime flags are not a user's shell environment.
      for (const key of ["PORT", "NODE_ENV"])
        if (input.env?.[key] === undefined) delete env[key];
      const pty = spawn(shell, args, {
        cwd,
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
          releaseOwnedProcess(
            ticket.id,
            entry.stopping || signal ? null : exitCode,
          );
          this.flush(ticket.id, entry);
          const terminal = this.has(ticket.id) ? this.get(ticket.id) : null;
          if (terminal)
            for (const listener of entry.listeners)
              listener({ type: "state", terminal });
          entry.finish();
          // Closed terminals are restored from their bounded on-disk transcript.
          this.live.delete(ticket.id);
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
              withoutExecutionContext(() =>
                getRawSqlite()
                  .prepare(
                    "UPDATE terminal_sessions SET process_identity=? WHERE id=?",
                  )
                  .run(identity, ticket.id),
              );
              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 20));
          }
        }
      } finally {
        identityReadyResolve?.();
      }
      assertRuntimeExecutionCurrent();
      if (input.stdin) pty.write(input.stdin);
      if (!this.flushTimer) {
        this.flushTimer = setInterval(
          () =>
            withoutExecutionContext(() => {
              for (const [id, value] of this.live)
                if (value.dirty) this.flush(id, value);
            }),
          3000,
        );
        this.flushTimer.unref();
      }
      return this.get(ticket.id);
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
    getRawSqlite()
      .prepare(
        "UPDATE terminal_sessions SET output_tail=?, output_sequence=? WHERE id=?",
      )
      .run(
        entry.frames.map((frame) => frame.data).join(""),
        entry.sequence,
        id,
      );
    entry.dirty = false;
  }
  snapshot(id: string): { sequence: number; data: string } {
    const entry = this.live.get(id);
    if (entry)
      return {
        sequence: entry.sequence,
        data: entry.frames.map((frame) => frame.data).join(""),
      };
    const row = getRawSqlite()
      .prepare(
        "SELECT output_tail, output_sequence FROM terminal_sessions WHERE id=?",
      )
      .get(id) as { output_tail: string; output_sequence: number } | undefined;
    if (!row) failure("Terminal not found.", 404);
    return { sequence: row.output_sequence, data: row.output_tail };
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
    getRawSqlite()
      .prepare("UPDATE terminal_sessions SET cols=?, rows=? WHERE id=?")
      .run(cols, rows, id);
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
    const record = this.row(id);
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
        getRawSqlite()
          .prepare(
            "UPDATE agent_runtime_processes SET state='unconfirmed' WHERE id=?",
          )
          .run(id);
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
      getRawSqlite()
        .prepare(
          "UPDATE agent_runtime_processes SET state='unconfirmed' WHERE id=?",
        )
        .run(id);
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
        getRawSqlite()
          .prepare(
            "UPDATE agent_runtime_processes SET state='unconfirmed' WHERE id=?",
          )
          .run(id);
        failure(
          "Terminal exit could not be confirmed. The process and its record were retained.",
        );
      }
      this.flush(id, entry);
    }
  }
  remove(id: string): void {
    if (
      this.get(id).state !== "closed" ||
      (this.live.has(id) && !this.live.get(id)!.closed)
    )
      failure("Stop this terminal before deleting its record.");
    getRawSqlite().transaction(() => {
      getRawSqlite()
        .prepare("DELETE FROM terminal_sessions WHERE id=?")
        .run(id);
      getRawSqlite()
        .prepare("DELETE FROM agent_runtime_processes WHERE id=?")
        .run(id);
    })();
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
