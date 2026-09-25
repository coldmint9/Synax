import { readFile, stat } from "node:fs/promises";
import { basename } from "node:path";
import {
  MAX_FILE_BYTES,
  modalityForMime,
  type RuntimeContentPart,
} from "../api/services/agent-runtime/content-parts.js";
import {
  createInterface,
  type Interface as ReadlineInterface,
} from "node:readline";
import { stdin, stdout, stderr } from "node:process";
import { randomUUID } from "node:crypto";
import path from "node:path";
import {
  createSynaxClient,
  SynaxRuntimeError,
} from "../api/services/agent-runtime/runtime-client.js";
import {
  exitCodeForError,
  exitCodeForRun,
  type RuntimeClient,
  type RuntimeEventEnvelope,
  type RuntimeInteraction,
  type RuntimeInteractionReply,
  type RuntimeTerminalResult,
} from "../api/services/agent-runtime/runtime-protocol.js";
import type { BackendCapabilities } from "../api/services/agent-runtime/backends/backend-contracts.js";
import type {
  CreateSessionRequest,
  PermissionReply,
  StreamTurnRequest,
} from "../api/services/agent-runtime/contracts.js";
import { HELP, parseArgs, type CliOptions, type OutputMode } from "./args.js";
import { ensureRuntime } from "./runtime-host.js";

export const CLI_VERSION = "1.1.0";
export const EXIT = {
  completed: 0,
  failed: 1,
  interrupted: 2,
  usage: 3,
  blocked: 4,
  transport: 5,
} as const;

type IO = {
  out: NodeJS.WriteStream;
  err: NodeJS.WriteStream;
  input: NodeJS.ReadStream;
};
const io: IO = { out: stdout, err: stderr, input: stdin };

function writeJson(out: NodeJS.WritableStream, value: unknown): void {
  out.write(`${JSON.stringify(value)}\n`);
}
function textOf(value: unknown): string {
  return typeof value === "string" ? value : JSON.stringify(value);
}
function payloadOf(event: RuntimeEventEnvelope): Record<string, unknown> {
  return event.payload as Record<string, unknown>;
}
function token(options: CliOptions): { token?: string; tokenFile?: string } {
  return { token: options.token, tokenFile: options.tokenFile };
}
function clientFor(options: CliOptions): RuntimeClient {
  return createSynaxClient({ baseUrl: options.url, ...token(options) });
}
function isTty(options: CliOptions): boolean {
  return options.output === "human" && Boolean(io.input.isTTY && io.out.isTTY);
}
function hasPendingStatus(status: string): boolean {
  return (
    status === "waiting_permission" ||
    status === "waiting_input" ||
    status === "blocked"
  );
}
async function requireCapability(
  client: RuntimeClient,
  sessionId: string,
  capability: keyof BackendCapabilities,
): Promise<void> {
  const descriptor = (await client.getSessionCapabilities(sessionId)).backend;
  const support = descriptor?.capabilities?.[capability];
  if (support !== "supported") {
    throw new SynaxRuntimeError(`Backend does not support ${capability}.`, {
      status: 400,
      code:
        support === "unverified"
          ? "BACKEND_CAPABILITY_UNVERIFIED"
          : "BACKEND_CAPABILITY_UNSUPPORTED",
    });
  }
}
function pathArg(options: CliOptions, index: number, name: string): string {
  const value = options.positionals[index];
  if (!value) throw new Error(`${name} requires a value.`);
  return value;
}

function printItems(
  options: CliOptions,
  kind: "backends" | "projects" | "sessions",
  items: Array<Record<string, unknown>>,
): void {
  if (options.output !== "human") return writeJson(io.out, { items });
  for (const item of items) {
    if (kind === "backends") {
      const caps = item.capabilities as Record<string, string> | undefined;
      const supported = caps
        ? Object.entries(caps)
            .filter(([, value]) => value === "supported")
            .map(([key]) => key)
            .join(", ")
        : "";
      io.out.write(
        `${String(item.id).padEnd(20)} ${String(item.label).padEnd(24)} ${String(item.kind).padEnd(8)} ${supported}\n`,
      );
    } else if (kind === "projects") {
      const source = item.source as { localPath?: string } | undefined;
      io.out.write(
        `${String(item.id).padEnd(24)} ${String(item.name).padEnd(28)} ${source?.localPath ?? ""}\n`,
      );
    } else {
      io.out.write(
        `${String(item.id).padEnd(32)} ${String(item.status).padEnd(20)} ${String(item.title ?? item.prompt ?? "").slice(0, 72)}\n`,
      );
    }
  }
}

function renderEvent(
  options: CliOptions,
  event: RuntimeEventEnvelope,
  output: IO = io,
): void {
  if (options.output === "jsonl") {
    writeJson(output.out, event);
    return;
  }
  if (options.output === "json") return;
  const payload = payloadOf(event);
  if (event.type === "message_delta") {
    output.out.write(textOf(payload.delta ?? ""));
    return;
  }
  if (event.type === "message") {
    const message = payload.message as { content?: string } | undefined;
    if (message?.content) output.out.write(message.content);
    return;
  }
  if (event.type === "thought_delta") return;
  if (event.type === "run_completed" || event.type === "done") {
    output.out.write("\n");
    return;
  }
  if (
    event.type === "tool_call" ||
    event.type === "tool_result" ||
    event.type === "run_failed" ||
    event.type === "permission_requested"
  ) {
    const tool = payload.toolCall as
      | {
          toolId?: string;
          inputSummary?: string;
          outputSummary?: string;
          status?: string;
        }
      | undefined;
    const permission = payload.permission as
      | { id?: string; reason?: string }
      | undefined;
    const line =
      event.type === "permission_requested"
        ? `[permission ${permission?.id ?? "unknown"}] ${permission?.reason ?? "reply with /approve <id> [once|always|reject]"}`
        : event.type === "run_failed"
          ? `[failed] ${String(payload.error ?? "Run failed.")}`
          : `[${event.type}] ${tool?.toolId ?? ""} ${tool?.inputSummary ?? tool?.outputSummary ?? tool?.status ?? ""}`;
    output.err.write(`${line.trim()}\n`);
  }
  if (event.type === "event") {
    const runtimeEvent = payload.event as
      | { type?: string; summary?: string }
      | undefined;
    if (runtimeEvent?.type === "interaction_requested")
      output.err.write(
        `[interaction] ${runtimeEvent.summary ?? "reply with /answer <id> <json>"}\n`,
      );
  }
}

function sessionBody(
  options: CliOptions,
  projectId: string,
  prompt: string,
): CreateSessionRequest {
  return {
    projectId,
    profileId: options.profile ?? process.env.SYNAX_PROFILE_ID ?? "synax",
    backendId: (options.backend ??
      process.env.SYNAX_BACKEND_ID ??
      "native") as CreateSessionRequest["backendId"],
    model: options.model,
    workDir: options.workDir ?? process.env.SYNAX_WORK_DIR ?? process.cwd(),
    prompt: prompt || "Interactive Synax session",
    reasoningEffort: options.reasoningEffort,
  };
}

async function resolveProject(
  client: RuntimeClient,
  options: CliOptions,
): Promise<string> {
  const selected = options.project ?? process.env.SYNAX_PROJECT_ID;
  if (selected) return selected;
  const workDir =
    options.workDir ?? process.env.SYNAX_WORK_DIR ?? process.cwd();
  const projects = await client.listProjects();
  const normalized = path.resolve(workDir);
  const matching = projects.items.find(
    (project) =>
      project.source?.kind === "localPath" &&
      project.source.localPath &&
      path.resolve(project.source.localPath) === normalized,
  );
  if (matching) return matching.id;
  const created = await client.createProject({
    name: path.basename(normalized) || "Synax workspace",
    environment: "development",
    source: { kind: "localPath", localPath: normalized },
  });
  return created.project.id;
}

async function ensureSession(
  client: RuntimeClient,
  options: CliOptions,
  prompt: string,
): Promise<string> {
  if (options.session) return options.session;
  const projectId = await resolveProject(client, options);
  return (await client.createSession(sessionBody(options, projectId, prompt)))
    .session.id;
}

function pendingFromEvent(event: RuntimeEventEnvelope): boolean {
  return (
    event.type === "permission_requested" ||
    (event.type === "event" &&
      (payloadOf(event).event as { type?: string } | undefined)?.type ===
        "interaction_requested")
  );
}

interface Observation {
  run: Awaited<ReturnType<RuntimeClient["getRun"]>>;
  session: Awaited<ReturnType<RuntimeClient["getSession"]>>["session"];
  pendingPermissions: Awaited<
    ReturnType<RuntimeClient["listPermissions"]>
  >["items"];
  pendingInteractions: RuntimeInteraction[];
  runtimeControl: unknown;
  detached: boolean;
}

async function observe(
  client: RuntimeClient,
  options: CliOptions,
  sessionId: string,
  runId: string,
  controller: AbortController,
  output: IO = io,
): Promise<Observation> {
  let detached = false;
  let stopForInput = false;
  let pollBusy = false;
  const interactive = isTty(options);
  const poll = setInterval(() => {
    if (pollBusy || controller.signal.aborted) return;
    pollBusy = true;
    void client
      .getRun(sessionId, runId)
      .then((run) => {
        if (!interactive && hasPendingStatus(run.status)) {
          stopForInput = true;
          controller.abort(new Error("Runtime awaits client input."));
        }
        if (
          run.status === "failed" ||
          run.status === "completed" ||
          run.status === "cancelled" ||
          run.status === "interrupted"
        )
          return;
      })
      .catch(() => undefined)
      .finally(() => {
        pollBusy = false;
      });
  }, 500);
  try {
    for await (const event of client.observeRun(sessionId, runId, {
      after: options.after,
      signal: controller.signal,
    })) {
      renderEvent(options, event, output);
      if (!interactive && pendingFromEvent(event)) {
        const payload = payloadOf(event);
        const permissionId =
          event.type === "permission_requested"
            ? (payload.permission as { id?: string } | undefined)?.id
            : undefined;
        const pendingPermissions = await client.listPermissions(sessionId);
        const pendingInteractions = await client.listInteractions(sessionId);
        const stillPending = permissionId
          ? pendingPermissions.items.some(
              (permission) =>
                permission.id === permissionId && !permission.resolvedAt,
            )
          : pendingInteractions.interactions.some(
              (interaction) => interaction.status === "pending",
            );
        if (stillPending) {
          stopForInput = true;
          controller.abort(new Error("Runtime awaits client input."));
          break;
        }
      }
    }
  } catch (error) {
    if (!controller.signal.aborted) throw error;
    if (
      !stopForInput &&
      controller.signal.reason instanceof Error &&
      controller.signal.reason.message === "detached"
    )
      detached = true;
  } finally {
    clearInterval(poll);
  }
  const run = await client.getRun(sessionId, runId);
  const sessionPayload = await client.getSession(sessionId);
  const permissions = (await client.listPermissions(sessionId)).items.filter(
    (permission) => !permission.resolvedAt,
  );
  const interactions = (
    await client.listInteractions(sessionId)
  ).interactions.filter((interaction) => interaction.status === "pending");
  const runtimeControl =
    sessionPayload.session.sessionMetadata?.runtimeControl ?? null;
  if (options.output === "jsonl") {
    writeJson(output.out, {
      protocol: "synax.runtime.v1",
      type: "result",
      sessionId,
      runId,
      run,
      permissions,
      interactions,
      runtimeControl,
      detached,
    });
  }
  return {
    run,
    session: sessionPayload.session,
    pendingPermissions: permissions,
    pendingInteractions: interactions,
    runtimeControl,
    detached,
  };
}

function finalResult(options: CliOptions, result: Observation): number {
  const code = result.detached
    ? EXIT.completed
    : exitCodeForRun(result.run.status, result.runtimeControl);
  if (options.output === "json") {
    const value: RuntimeTerminalResult = {
      protocol: "synax.runtime.v1",
      sessionId: result.run.sessionId,
      runId: result.run.id,
      status: result.run.status,
      run: result.run,
      exitCode: code as RuntimeTerminalResult["exitCode"],
      permissions: result.pendingPermissions,
      interactions: result.pendingInteractions,
      runtimeControl: result.runtimeControl,
    };
    writeJson(io.out, value);
  }
  if (!result.detached && code === EXIT.blocked)
    io.err.write(
      "Runtime is waiting for permission or input; resume with synax approve/answer.\n",
    );
  return code;
}

const uploadedFiles = new WeakMap<
  CliOptions,
  { projectId: string; parts: RuntimeContentPart[] }
>();
async function turnInput(
  client: RuntimeClient,
  options: CliOptions,
  sessionId: string,
  message?: string,
): Promise<StreamTurnRequest> {
  if (!options.files?.length)
    return message
      ? {
          message,
          model: options.model,
          reasoningEffort: options.reasoningEffort,
        }
      : {};
  const { session } = await client.getSession(sessionId);
  let cached = uploadedFiles.get(options);
  if (!cached || cached.projectId !== session.projectId) {
    if (options.files.length > 10)
      throw new Error("At most 10 files may be attached.");
    const sizes = await Promise.all(options.files.map((file) => stat(file)));
    if (
      sizes.some((s) => !s.isFile() || !s.size || s.size > MAX_FILE_BYTES) ||
      sizes.reduce((sum, s) => sum + s.size, 0) > 100 * 1024 * 1024
    )
      throw new Error("Attachments exceed file or input limits.");
    cached = { projectId: session.projectId, parts: [] };
    for (const file of options.files) {
      const bytes = await readFile(file);
      const { asset } = await client.uploadAsset(
        session.projectId,
        new File([new Uint8Array(bytes)], basename(file)),
      );
      cached.parts.push({
        type: modalityForMime(asset.mediaType),
        assetId: asset.id,
      });
    }
    uploadedFiles.set(options, cached);
  }
  return {
    message,
    model: options.model,
    reasoningEffort: options.reasoningEffort,
    contentParts: [
      ...(message ? [{ type: "text" as const, text: message }] : []),
      ...cached.parts,
    ],
  };
}
async function submitAndObserve(
  client: RuntimeClient,
  options: CliOptions,
  sessionId: string,
  message: string | undefined,
  mode: "turn" | "continue",
  controller = new AbortController(),
): Promise<{ result: Observation; controller: AbortController }> {
  const accepted = await client.submitRun(
    sessionId,
    await turnInput(client, options, sessionId, message),
    {
      requestId: options.requestId ?? `synax-cli-${randomUUID()}`,
      mode,
    },
  );
  options.files = undefined;
  uploadedFiles.delete(options);
  const result = await observe(
    client,
    options,
    sessionId,
    accepted.run.id,
    controller,
  );
  return { result, controller };
}

async function runExec(
  client: RuntimeClient,
  options: CliOptions,
  message: string | undefined,
): Promise<number> {
  const sessionId = await ensureSession(
    client,
    options,
    message ?? "Synax CLI execution",
  );
  if (isTty(options))
    return interactiveSession(
      client,
      { ...options, session: sessionId },
      message,
      true,
    );
  const { result } = await submitAndObserve(
    client,
    options,
    sessionId,
    message,
    "turn",
  );
  return finalResult(options, result);
}

async function continueOrAttach(
  client: RuntimeClient,
  options: CliOptions,
  sessionId: string,
  message?: string,
): Promise<number> {
  const session = (await client.getSession(sessionId)).session;
  if (
    session.activeRunId &&
    ["queued", "running", "waiting_permission", "waiting_input"].includes(
      session.status,
    )
  ) {
    if (message)
      throw new Error(
        `Session has an active Run ${session.activeRunId}; observe or resolve it before submitting another message.`,
      );
    const result = await observe(
      client,
      options,
      sessionId,
      session.activeRunId,
      new AbortController(),
    );
    return finalResult(options, result);
  }
  await requireCapability(client, sessionId, "resume");
  const { result } = await submitAndObserve(
    client,
    { ...options, session: sessionId },
    sessionId,
    message,
    "continue",
  );
  return finalResult(options, result);
}

function parseControl(line: string): { command: string; args: string[] } {
  const parts = line.trim().split(/\s+/);
  return { command: parts[0] ?? "", args: parts.slice(1) };
}

async function replyPermission(
  client: RuntimeClient,
  sessionId: string,
  args: string[],
): Promise<void> {
  const id = args[0];
  if (!id) throw new Error("/approve requires a permission ID.");
  const reply = (args[1] ?? "once") as PermissionReply;
  if (!["once", "always", "reject"].includes(reply))
    throw new Error("Permission reply must be once, always, or reject.");
  await client.replyPermission(sessionId, id, reply);
}

async function replyInteraction(
  client: RuntimeClient,
  sessionId: string,
  args: string[],
): Promise<void> {
  const id = args.shift();
  if (!id) throw new Error("/answer requires an interaction ID.");
  const raw = args.join(" ").trim();
  if (!raw)
    throw new Error("/answer requires JSON answers or an action object.");
  const parsed = JSON.parse(raw) as
    | RuntimeInteractionReply["answers"]
    | RuntimeInteractionReply;
  const current = (await client.listInteractions(sessionId)).interactions.find(
    (item) => item.id === id,
  );
  if (!current) throw new Error(`Interaction not found: ${id}`);
  const reply: RuntimeInteractionReply =
    "action" in (parsed as object)
      ? {
          ...(parsed as RuntimeInteractionReply),
          revision:
            (parsed as RuntimeInteractionReply).revision ?? current.revision,
        }
      : {
          revision: current.revision,
          action: "submit",
          answers: parsed as RuntimeInteractionReply["answers"],
        };
  await client.replyInteraction(sessionId, id, reply);
}

async function startObservation(
  client: RuntimeClient,
  options: CliOptions,
  sessionId: string,
  runId: string,
  oneShot: boolean,
  rl: ReadlineInterface,
): Promise<{ observation: Observation; controller: AbortController }> {
  const controller = new AbortController();
  const promise = observe(client, options, sessionId, runId, controller);
  const observation = await promise;
  if (oneShot) rl.close();
  return { observation, controller };
}

async function interactiveSession(
  client: RuntimeClient,
  options: CliOptions,
  initialMessage?: string,
  oneShot = false,
): Promise<number> {
  const rl = createInterface({
    input: io.input,
    output: io.err,
    terminal: true,
  });
  let sessionId = options.session;
  let active:
    | {
        runId: string;
        controller: AbortController;
        promise: Promise<Observation>;
      }
    | undefined;
  let closing = false;
  let finalCode: number = EXIT.completed;
  const start = async (
    message: string | undefined,
    mode: "turn" | "continue",
  ): Promise<void> => {
    if (active) {
      io.err.write(
        "A Run is active. Use /approve, /answer, /cancel, or /exit.\n",
      );
      return;
    }
    if (!sessionId)
      sessionId = await ensureSession(
        client,
        options,
        message ?? "Interactive Synax session",
      );
    const activeSessionId = sessionId;
    const accepted = await client.submitRun(
      activeSessionId,
      await turnInput(client, options, activeSessionId, message),
      { requestId: options.requestId ?? `synax-cli-${randomUUID()}`, mode },
    );
    options.files = undefined;
    uploadedFiles.delete(options);
    const controller = new AbortController();
    active = {
      runId: accepted.run.id,
      controller,
      promise: observe(
        client,
        options,
        activeSessionId,
        accepted.run.id,
        controller,
      ),
    };
    void active.promise
      .then((result) => {
        if (!closing) {
          finalCode = finalResult(options, result);
          if (oneShot) {
            closing = true;
            rl.close();
          }
        }
      })
      .catch((error) => {
        if (!closing) {
          io.err.write(
            `Run error: ${error instanceof Error ? error.message : String(error)}\n`,
          );
          finalCode = exitCodeForError(error);
          if (oneShot) {
            closing = true;
            rl.close();
          }
        }
      })
      .finally(() => {
        active = undefined;
        if (!closing) rl.prompt();
      });
  };
  const stop = async (cancel: boolean): Promise<void> => {
    const current = active;
    if (!current || !sessionId) return;
    if (cancel) await client.cancelSession(sessionId, current.runId);
    current.controller.abort(new Error(cancel ? "cancelled" : "detached"));
    await current.promise.catch(() => undefined);
    active = undefined;
  };
  rl.on("SIGINT", () => {
    if (active) void stop(true);
    else {
      closing = true;
      rl.close();
    }
  });
  rl.setPrompt(`synax${sessionId ? `:${sessionId.slice(-8)}` : ""}> `);
  if (initialMessage || options.files?.length)
    await start(initialMessage, "turn");
  else if (sessionId) {
    const current = (await client.getSession(sessionId)).session.activeRunId;
    if (current) {
      const controller = new AbortController();
      active = {
        runId: current,
        controller,
        promise: observe(client, options, sessionId, current, controller),
      };
      void active.promise
        .then((result) => {
          if (!closing) finalCode = finalResult(options, result);
        })
        .finally(() => {
          active = undefined;
          if (!closing) rl.prompt();
        });
    }
  }
  if (!closing) rl.prompt();
  for await (const raw of rl) {
    const line = raw.trim();
    if (!line) {
      if (!closing) rl.prompt();
      continue;
    }
    if (line.startsWith("/")) {
      const { command, args } = parseControl(line);
      try {
        if (command === "/exit" || command === "/quit") {
          closing = true;
          if (active) await stop(false);
          rl.close();
          break;
        }
        if (command === "/approve") {
          if (!sessionId) throw new Error("No active session.");
          await replyPermission(client, sessionId, args);
        } else if (command === "/answer") {
          if (!sessionId) throw new Error("No active session.");
          await replyInteraction(client, sessionId, args);
        } else if (command === "/cancel") {
          await stop(true);
        } else if (command === "/new") {
          if (active) throw new Error("Stop the active Run first.");
          sessionId = undefined;
        } else if (command === "/resume") {
          if (active) throw new Error("Stop the active Run first.");
          sessionId = args[0] ?? sessionId;
          if (!sessionId) throw new Error("/resume requires a session ID.");
        } else if (command === "/sessions")
          printItems(
            options,
            "sessions",
            (await client.listSessions()).items as unknown as Array<
              Record<string, unknown>
            >,
          );
        else if (command === "/help")
          io.err.write(
            "/new /sessions /resume <id> /approve <id> [reply] /answer <id> <json> /cancel /exit\n",
          );
        else io.err.write("Unknown command. Use /help.\n");
      } catch (error) {
        io.err.write(
          `${error instanceof Error ? error.message : String(error)}\n`,
        );
      }
      if (!closing) rl.prompt();
      continue;
    }
    if (active) {
      io.err.write("A Run is active. Use a slash control command.\n");
      if (!closing) rl.prompt();
      continue;
    }
    try {
      await start(line, "turn");
    } catch (error) {
      io.err.write(
        `${error instanceof Error ? error.message : String(error)}\n`,
      );
      finalCode = exitCodeForError(error);
      if (oneShot) {
        closing = true;
        rl.close();
        break;
      }
    }
  }
  closing = true;
  if (active) await stop(false);
  rl.close();
  return oneShot ? finalCode : EXIT.completed;
}

async function runRpc(client: RuntimeClient): Promise<number> {
  const rl = createInterface({ input: io.input, crlfDelay: Infinity });
  const running = new Map<string, Promise<void>>();
  const controllers = new Map<string, AbortController>();
  const send = (value: unknown) => writeJson(io.out, value);
  const required = (params: Record<string, unknown>, name: string): string => {
    const value = params[name];
    if (typeof value !== "string" || !value)
      throw new Error(`${name} is required.`);
    return value;
  };
  const dispatch = async (request: {
    id?: string | number;
    method: string;
    params?: Record<string, unknown>;
  }): Promise<void> => {
    const params = request.params ?? {};
    const id = request.id ?? randomUUID();
    if (request.method === "runs.watch") {
      const sessionId = required(params, "sessionId");
      const runId = required(params, "runId");
      const controller = new AbortController();
      controllers.set(String(id), controller);
      try {
        for await (const event of client.observeRun(sessionId, runId, {
          after: Number(params.after ?? 0),
          signal: controller.signal,
        }))
          send({ id, event });
        send({ id, ok: true, result: await client.getRun(sessionId, runId) });
      } finally {
        controllers.delete(String(id));
      }
      return;
    }
    let result: unknown;
    switch (request.method) {
      case "backends.list":
        result = await client.listBackends();
        break;
      case "projects.list":
        result = await client.listProjects();
        break;
      case "sessions.list":
        result = await client.listSessions(
          params as Record<string, string | number | undefined>,
        );
        break;
      case "sessions.get":
        result = await client.getSession(required(params, "sessionId"));
        break;
      case "sessions.create":
        result = await client.createSession(
          params as unknown as CreateSessionRequest,
        );
        break;
      case "sessions.inputCapabilities":
        result = await client.getInputCapabilities(
          required(params, "sessionId"),
          typeof params.model === "string" ? params.model : undefined,
        );
        break;
      case "assets.get":
        result = await client.getAsset(required(params, "assetId"));
        break;
      case "assets.delete":
        result = await client.deleteAsset(required(params, "assetId"));
        break;
      case "assets.upload": {
        const file = required(params, "path");
        const size = await stat(file);
        if (!size.isFile() || size.size > MAX_FILE_BYTES)
          throw new Error("File must be at most 50 MiB.");
        result = await client.uploadAsset(
          required(params, "projectId"),
          new File([new Uint8Array(await readFile(file))], basename(file)),
        );
        break;
      }
      case "runs.submit":
        result = await client.submitRun(
          required(params, "sessionId"),
          (params.input ?? {}) as StreamTurnRequest,
          {
            requestId: required(params, "requestId"),
            mode: params.mode === "continue" ? "continue" : "turn",
          },
        );
        break;
      case "permissions.reply":
        result = await client.replyPermission(
          required(params, "sessionId"),
          required(params, "permissionId"),
          params.reply as PermissionReply,
          typeof params.message === "string" ? params.message : undefined,
        );
        break;
      case "interactions.reply":
        result = await client.replyInteraction(
          required(params, "sessionId"),
          required(params, "interactionId"),
          params.reply as RuntimeInteractionReply,
        );
        break;
      case "sessions.cancel":
        result = await client.cancelSession(
          required(params, "sessionId"),
          typeof params.runId === "string" ? params.runId : undefined,
        );
        break;
      default:
        throw new Error(`Unknown RPC method: ${request.method}`);
    }
    send({ id, ok: true, result });
  };
  for await (const line of rl) {
    if (!line.trim()) continue;
    let request: {
      id?: string | number;
      method: string;
      params?: Record<string, unknown>;
    };
    try {
      request = JSON.parse(line) as typeof request;
    } catch {
      send({ ok: false, error: "Invalid JSON request." });
      continue;
    }
    if (!request || typeof request.method !== "string") {
      send({ id: request?.id, ok: false, error: "method is required." });
      continue;
    }
    const id = String(request.id ?? randomUUID());
    if (running.has(id)) {
      send({
        id: request.id,
        ok: false,
        error: "request id is already running.",
      });
      continue;
    }
    const task = dispatch(request)
      .catch((error) =>
        send({
          id: request.id,
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
      )
      .finally(() => running.delete(id));
    running.set(id, task);
  }
  await Promise.all(running.values());
  for (const controller of controllers.values()) controller.abort();
  return EXIT.completed;
}

async function messageFrom(options: CliOptions): Promise<string | undefined> {
  if (options.positionals[0] !== "-")
    return options.positionals.join(" ") || undefined;
  if (io.input.isTTY) throw new Error("exec - requires piped stdin.");
  let value = "";
  for await (const chunk of io.input) value += chunk;
  return value.trim() || undefined;
}

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const options = parseArgs(argv);
  if (options.version) {
    io.out.write(`${CLI_VERSION}\n`);
    return EXIT.completed;
  }
  if (options.help) {
    io.out.write(HELP);
    return EXIT.completed;
  }
  const runtime = await ensureRuntime(options);
  const client = createSynaxClient({
    baseUrl: runtime.baseUrl,
    token: options.token,
    tokenFile:
      options.tokenFile ??
      (runtime.managed || (!options.url && !process.env.SYNAX_API)
        ? runtime.tokenFile
        : undefined),
  });
  switch (options.command) {
    case "backends": {
      const result = await client.listBackends();
      if (options.output === "human")
        printItems(
          options,
          "backends",
          result.items as unknown as Array<Record<string, unknown>>,
        );
      else writeJson(io.out, result);
      return EXIT.completed;
    }
    case "models": {
      const result = await client.listBackendModels(
        pathArg(options, 0, "models"),
      );
      options.output === "human"
        ? result.models.forEach((model) =>
            io.out.write(`${model.id.padEnd(28)} ${model.label}\n`),
          )
        : writeJson(io.out, result);
      return EXIT.completed;
    }
    case "projects": {
      const result = await client.listProjects();
      if (options.output === "human")
        printItems(
          options,
          "projects",
          result.items as unknown as Array<Record<string, unknown>>,
        );
      else writeJson(io.out, result);
      return EXIT.completed;
    }
    case "sessions": {
      const result = await client.listSessions();
      if (options.output === "human")
        printItems(
          options,
          "sessions",
          result.items as unknown as Array<Record<string, unknown>>,
        );
      else writeJson(io.out, result);
      return EXIT.completed;
    }
    case "exec":
      return runExec(client, options, await messageFrom(options));
    case "resume": {
      const sessionId = options.session ?? pathArg(options, 0, "resume");
      const message =
        options.positionals.slice(options.session ? 0 : 1).join(" ") ||
        undefined;
      if (isTty(options))
        return interactiveSession(
          client,
          { ...options, session: sessionId },
          message,
          Boolean(message),
        );
      return continueOrAttach(client, options, sessionId, message);
    }
    case "watch": {
      const sessionId = options.session;
      const runId = options.run ?? pathArg(options, 0, "watch");
      if (!sessionId) throw new Error("watch requires --session <session-id>.");
      if (isTty(options))
        return interactiveSession(
          client,
          { ...options, session: sessionId },
          undefined,
          false,
        );
      const controller = new AbortController();
      const result = await observe(
        client,
        options,
        sessionId,
        runId,
        controller,
      );
      return finalResult(options, result);
    }
    case "approve": {
      const sessionId = options.session;
      if (!sessionId)
        throw new Error("approve requires --session <session-id>.");
      const result = await client.replyPermission(
        sessionId,
        pathArg(options, 0, "approve"),
        options.reply ?? "once",
      );
      options.output === "human"
        ? writeJson(io.out, result)
        : writeJson(io.out, result);
      return EXIT.completed;
    }
    case "answer": {
      const sessionId = options.session;
      if (!sessionId)
        throw new Error("answer requires --session <session-id>.");
      const id = pathArg(options, 0, "answer");
      const current = (
        await client.listInteractions(sessionId)
      ).interactions.find((item) => item.id === id);
      if (!current) throw new Error(`Interaction not found: ${id}`);
      const parsed = options.answers
        ? (JSON.parse(options.answers) as RuntimeInteractionReply["answers"])
        : {};
      const result = await client.replyInteraction(sessionId, id, {
        revision: current.revision,
        action:
          (options.action as RuntimeInteractionReply["action"]) ?? "submit",
        answers: parsed,
      });
      writeJson(io.out, result);
      return EXIT.completed;
    }
    case "cancel":
      if (!options.session)
        throw new Error("cancel requires --session <session-id>.");
      writeJson(
        io.out,
        await client.cancelSession(options.session, options.run),
      );
      return EXIT.completed;
    case "rpc":
      return runRpc(client);
    case "chat":
      return isTty(options)
        ? interactiveSession(client, options)
        : runExec(client, options, await messageFrom(options));
    default:
      throw new Error(`Unknown command: ${options.command}. Use --help.`);
  }
}
