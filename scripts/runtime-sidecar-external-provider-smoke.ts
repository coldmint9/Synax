import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const REQUIRED_ENV = [
  "SYNAX_EXTERNAL_PROVIDER_BASE_URL",
  "SYNAX_EXTERNAL_PROVIDER_API_KEY",
  "SYNAX_EXTERNAL_PROVIDER_MODEL",
] as const;

const missing = REQUIRED_ENV.filter((name) => !process.env[name]?.trim());
if (missing.length > 0) {
  console.error(
    `External provider smoke skipped: missing ${missing.join(", ")}. ` +
      "Set all three variables; this harness never falls back to a local provider.",
  );
  process.exit(2);
}

const baseUrl = process.env.SYNAX_EXTERNAL_PROVIDER_BASE_URL!.trim().replace(/\/+$/, "");
const apiKey = process.env.SYNAX_EXTERNAL_PROVIDER_API_KEY!.trim();
const model = process.env.SYNAX_EXTERNAL_PROVIDER_MODEL!.trim();
const parsedBaseUrl = new URL(baseUrl);
if (!/^https?:$/.test(parsedBaseUrl.protocol)) {
  throw new Error("SYNAX_EXTERNAL_PROVIDER_BASE_URL must use http or https.");
}

const root = await mkdtemp(path.join(tmpdir(), "synax-runtime-external-provider-"));
const projectId = "external-provider-smoke";
let runtime: { stop(): Promise<void> } | undefined;
let client: { close(): void } | undefined;

try {
  await writeFile(
    path.join(root, "projects.json"),
    JSON.stringify({ items: [{ id: projectId, source: { localPath: root } }] }),
  );

  Object.assign(process.env, {
    DATA_ROOT: root,
    NODE_ENV: "test",
    SYNAX_RUNTIME_SIDECAR_SUPERVISOR: "1",
    SYNAX_RUNTIME_SIDECAR_STREAM: "authoritative",
    SYNAX_AGENT_SESSION_IN_PROCESS: "0",
  });

  const { RustRuntimeSupervisor } = await import(
    "../services/local-node/infrastructure/runtime/rust-sidecar.js"
  );
  const supervisor = new RustRuntimeSupervisor({ dataRoot: root });
  await supervisor.start();
  runtime = supervisor;

  const { RuntimeSidecarClient } = await import(
    "../services/local-node/modules/agent-runtime/sidecar/sidecar-client.js"
  );
  const sidecarClient = new RuntimeSidecarClient({
    socketPath: supervisor.socketPath,
    token: supervisor.token,
  });
  client = sidecarClient;

  const { updateGlobalConfig } = await import(
    "../services/local-node/infrastructure/runtime/config/config-store.js"
  );
  updateGlobalConfig(
    {
      defaultApiProviderId: "openai",
      providerConnections: {
        openai: {
          providerId: "openai",
          baseUrl,
          apiKey,
          extra: { kind: "api", apiFormat: "openai", model },
        },
      },
    },
    "runtime-external-provider-smoke",
  );

  const { agentSessionRuntime } = await import(
    "../services/local-node/modules/agent-runtime/session-runtime.js"
  );
  const { RunCoordinator } = await import(
    "../services/local-node/modules/agent-runtime/run-coordinator.js"
  );
  const { ensureSynaxAgentRegistered, ensureLegacyGoalProfileRegistered } =
    await import("../services/local-node/modules/agent-runtime/synax/index.js");

  ensureSynaxAgentRegistered();
  ensureLegacyGoalProfileRegistered();
  const session = agentSessionRuntime.create({
    projectId,
    profileId: "synax",
    model: `openai/${model}`,
    prompt: "Use the configured external provider for one short answer.",
    workDir: root,
  });

  const coordinator = new RunCoordinator();
  const accepted = await coordinator.submitAsync(
    session.id,
    {
      model: `openai/${model}`,
      message:
        "Reply with one brief sentence confirming that the external provider is responding.",
      maxSteps: 2,
    },
    "external-provider-smoke-turn",
  );
  await coordinator.waitForIdle();

  const replay = await sidecarClient.replay(session.id, 0);
  const replayChunks = replay.events.map((event) => {
    try {
      return JSON.parse(new TextDecoder().decode(event.payload)) as {
        chunk?: { type?: string; delta?: string; run?: { status?: string } };
      };
    } catch {
      return {};
    }
  });
  assert(
    replayChunks.some(
      (record) =>
        record.chunk?.type === "message_delta" &&
        typeof record.chunk.delta === "string" &&
        record.chunk.delta.length > 0,
    ),
    "external provider turn must produce streamed message_delta events",
  );
  assert(
    replayChunks.some(
      (record) =>
        record.chunk?.type === "run_completed" ||
        record.chunk?.type === "run_finished",
    ),
    "authoritative stream must contain a terminal finish event",
  );

  const history = JSON.parse(
    new TextDecoder().decode(
      await sidecarClient.historyCommand({
        sessionId: session.id,
        requestId: "external-provider-history-runs",
        operation: "list_runs",
        payload: {},
      }),
    ),
  ) as { items: Array<{ id: string; status?: string }> };
  const historyRun = history.items.find((item) => item.id === accepted.run.id);
  assert(historyRun, "terminal run must be present in Rust authoritative history");
  assert.equal(historyRun.status, "completed");

  const messages = JSON.parse(
    new TextDecoder().decode(
      await sidecarClient.historyCommand({
        sessionId: session.id,
        requestId: "external-provider-history-messages",
        operation: "list_messages",
        payload: {},
      }),
    ),
  ) as { items: Array<{ role?: string; content?: string }> };
  assert(
    messages.items.some(
      (message) =>
        message.role === "assistant" &&
        typeof message.content === "string" &&
        message.content.trim().length > 0,
    ),
    "Rust authoritative history must contain the external provider assistant reply",
  );

  const head = JSON.parse(
    new TextDecoder().decode(
      await sidecarClient.historyCommand({
        sessionId: session.id,
        requestId: "external-provider-history-head",
        operation: "head_read",
        payload: {},
      }),
    ),
  ) as { objectId?: string; revision?: number };
  assert(typeof head.objectId === "string" && (head.revision ?? 0) > 0);
  const integrity = JSON.parse(
    new TextDecoder().decode(
      await sidecarClient.historyCommand({
        sessionId: "__system__",
        requestId: "external-provider-history-verify",
        operation: "verify",
        payload: {},
      }),
    ),
  ) as { ok: boolean };
  assert.equal(integrity.ok, true);

  console.log(
    `External provider smoke passed: forked agent-session-runner → Node coordinator → ${parsedBaseUrl.origin} → Rust authoritative stream/history (model=${model}).`,
  );
} finally {
  client?.close();
  await runtime?.stop().catch(() => {});
  await rm(root, { recursive: true, force: true });
}
