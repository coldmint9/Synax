/** Local by default. Real provider traffic requires --live --model <configured model>. */
import http from "node:http";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { buildLoopSystemPrompt } from "../api/services/agent-runtime/loop-prompt.js";
import { synaxAgentProfile } from "../api/services/agent-runtime/synax/synax-agent-profile.js";
import {
  buildSynaxRuntimeState,
  synaxModePromptRegistry,
} from "../api/services/agent-runtime/synax/synax-mode-prompt.js";
import { snapshotRuntimeReminder } from "../api/services/agent-runtime/runtime-request-snapshot.js";
import {
  fingerprintGatewayRequest,
  compareRequests,
  readCacheFingerprint,
  summarizeCacheMeasurements,
  type CacheMeasurement,
  type CacheRequestFingerprint,
} from "../api/services/llm-runtime/cache-diagnostics.js";
import { normalizeUsage } from "../api/services/llm-runtime/usage.js";
import { executePipeline } from "../api/services/llm-runtime/pipeline.js";
import type {
  LlmGatewayMessage,
  LlmGatewayRequest,
  ResolvedModelSelection,
} from "../api/services/llm-runtime/types.js";
import type { AgentContextBundle } from "../api/services/agent-runtime/contracts.js";

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const live = args.includes("--live");
const storedSession = option("--session");
if (storedSession && (live || !option("--db")))
  throw new Error(
    "--session requires --db <existing context.db> and cannot be combined with --live.",
  );
const outDir = resolve(option("--out") ?? ".tmp/prompt-cache");
process.env.SYNAX_PROMPT_CACHE_DIAGNOSTICS = "1";
if (live && !option("--model"))
  throw new Error(
    "--live requires --model <existing configured model>; no credentials are accepted by this script.",
  );

function countMarkers(value: unknown): number {
  if (!value || typeof value !== "object") return 0;
  if (Array.isArray(value))
    return value.reduce((sum, part) => sum + countMarkers(part), 0);
  return Object.entries(value).reduce(
    (sum, [key, part]) =>
      sum + (key === "cache_control" ? 1 : countMarkers(part)),
    0,
  );
}
const wire: Array<{
  protocol: string;
  bytes: number;
  markers: number;
  fingerprint: CacheRequestFingerprint;
}> = [];
let requestNumber = 0;
const server = http.createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
  req.on("end", () => {
    const raw = Buffer.concat(chunks).toString("utf8");
    const body = JSON.parse(raw);
    const protocol = req.url?.endsWith("/messages")
      ? "anthropic"
      : req.url?.endsWith("/responses")
        ? "openai-responses"
        : "openai";
    const read = requestNumber++ % 3 === 0 ? 0 : 8000;
    // Counts are fixture values, not evidence of a cache at this stub or any real provider.
    wire.push({
      protocol,
      bytes: Buffer.byteLength(raw),
      markers: countMarkers(body),
      fingerprint: { version: 1, blocks: fingerprintGatewayBody(body).blocks },
    });
    const usage =
      protocol === "anthropic"
        ? {
            input_tokens: 10000 - read,
            output_tokens: 1,
            cache_read_input_tokens: read,
            cache_creation_input_tokens: 0,
          }
        : protocol === "openai-responses"
          ? {
              input_tokens: 10000,
              output_tokens: 1,
              total_tokens: 10001,
              input_tokens_details: { cached_tokens: read },
            }
          : {
              prompt_tokens: 10000,
              completion_tokens: 1,
              total_tokens: 10001,
              prompt_cache_hit_tokens: read,
            };
    const payload =
      protocol === "anthropic"
        ? {
            id: "msg_fixture",
            type: "message",
            role: "assistant",
            model: body.model,
            content: [{ type: "text", text: "ok" }],
            stop_reason: "end_turn",
            stop_sequence: null,
            usage,
          }
        : protocol === "openai-responses"
          ? {
              id: "resp_fixture",
              object: "response",
              created_at: 1,
              status: "completed",
              model: body.model,
              output: [
                {
                  id: "msg_fixture",
                  type: "message",
                  role: "assistant",
                  status: "completed",
                  content: [
                    { type: "output_text", text: "ok", annotations: [] },
                  ],
                },
              ],
              incomplete_details: null,
              usage,
            }
          : {
              id: "chat_fixture",
              object: "chat.completion",
              created: 1,
              model: body.model,
              choices: [
                {
                  index: 0,
                  message: { role: "assistant", content: "ok" },
                  finish_reason: "stop",
                },
              ],
              usage,
            };
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(payload));
  });
});
// The raw body is deliberately not retained or written to the report.
function fingerprintGatewayBody(body: unknown) {
  return fingerprintRequest([{ role: "wire", content: body }]);
}
import { fingerprintRequest } from "../api/services/llm-runtime/cache-diagnostics.js";

const measurements: Array<
  CacheMeasurement & {
    scenario: string;
    historyAnchorStatus?: string;
    outcome?: "completed" | "failed";
    errorType?: string;
    request?: CacheRequestFingerprint;
    comparison: unknown;
    localWire?: (typeof wire)[number];
  }
> = [];
const scenarios = live
  ? ["synthetic-stable-prefix"]
  : [
      "no-reference",
      "code-map-wiki",
      "work-evidence",
      "saved-approved-plan",
      "long-history",
      "compression",
      "recovery",
    ];
let selections: ResolvedModelSelection[] = [];
let regression: { status: string; exitCode: number | null; scope: string } = {
  status: "not-run",
  exitCode: null,
  scope: "local Native request/regression fixtures",
};
try {
  if (storedSession) {
    const { default: Database } = await import("libsql");
    const db = new Database(resolve(option("--db")!), {
      readonly: true,
      fileMustExist: true,
    });
    const parse = (value: unknown): Record<string, any> => {
      try {
        return typeof value === "string" ? (JSON.parse(value) ?? {}) : {};
      } catch {
        return {};
      }
    };
    try {
      const ids = db
        .prepare(
          "WITH RECURSIVE tree(id) AS (SELECT id FROM agent_runtime_sessions WHERE id=? UNION SELECT s.id FROM agent_runtime_sessions s JOIN tree ON s.parent_session_id=tree.id) SELECT id FROM tree",
        )
        .all(storedSession) as { id: string }[];
      if (!ids.length)
        throw new Error(
          "Session not found in the explicitly selected database.",
        );
      const placeholders = ids.map(() => "?").join(",");
      const keys = ids.map((row) => row.id);
      const rows = db
        .prepare(
          `SELECT id, session_id, model, metadata_json, started_at, completed_at FROM agent_runtime_run_steps WHERE session_id IN (${placeholders}) ORDER BY started_at, rowid`,
        )
        .all(...keys) as Array<Record<string, any>>;
      for (const row of rows) {
        const metadata = parse(row.metadata_json);
        const native = metadata.cacheDiagnostics;
        const adapter = metadata.providerMetadata?.synax?.cacheDiagnostics;
        measurements.push({
          provider: adapter?.provider ?? "unknown",
          model: adapter?.model ?? row.model ?? "unknown",
          source: row.session_id === storedSession ? "main" : "subsession",
          phase: native?.phase ?? adapter?.phase ?? "unknown",
          scenario: "stored-native-request",
          usage: normalizeUsage(metadata.usage, {
            providerMetadata: metadata.providerMetadata,
          }),
          firstTokenMs: adapter?.firstTokenMs ?? null,
          durationMs: adapter?.durationMs ?? null,
          cost: null,
          request: readCacheFingerprint(native?.request),
          comparison: native?.comparison ?? null,
        });
      }
      if (
        db
          .prepare(
            "SELECT 1 FROM sqlite_master WHERE type='table' AND name='agent_runtime_aux_usage'",
          )
          .get()
      ) {
        const auxiliary = db
          .prepare(
            `SELECT usage_json FROM agent_runtime_aux_usage WHERE session_id IN (${placeholders})`,
          )
          .all(...keys) as { usage_json: string | null }[];
        for (const row of auxiliary)
          measurements.push({
            provider: "unknown",
            model: "unknown",
            source: "auxiliary",
            phase: "unknown",
            scenario: "stored-auxiliary-request",
            usage: parse(row.usage_json),
            firstTokenMs: null,
            durationMs: null,
            cost: null,
            comparison: null,
          });
      }
    } finally {
      db.close();
    }
  } else if (live) {
    const { resolveGatewaySelection } =
      await import("../api/services/llm-runtime/gateway.js");
    selections = [
      await resolveGatewaySelection({
        purpose: "validate",
        model: option("--model"),
      }),
    ];
  } else {
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    const address = server.address() as { port: number };
    selections = (["openai", "openai-responses", "anthropic"] as const).map(
      (protocol) => ({
        providerId: `local-${protocol}`,
        modelId:
          protocol === "anthropic" ? "claude-sonnet-4-5" : "fixture-model",
        model: `local-${protocol}/fixture-model`,
        apiFormat: protocol,
        provider: {
          id: `local-${protocol}`,
          label: "Local capture only",
          npm:
            protocol === "anthropic"
              ? "@ai-sdk/anthropic"
              : protocol === "openai"
                ? "@ai-sdk/openai-compatible"
                : "@ai-sdk/openai",
          env: [],
          supported: true,
          models: [],
        },
        modelDef: {
          id: "fixture-model",
          label: "Local fixture",
          contextLimit: 200000,
          reasoning: false,
        },
        config: {
          providerId: `local-${protocol}`,
          apiFormat: protocol,
          apiKey: "local-fixture-not-a-credential",
          baseUrl: `http://127.0.0.1:${address.port}/v1`,
          options: { promptCaching: "auto" },
        },
      }),
    );
  }
  for (const selection of selections)
    for (const scenario of scenarios) {
      let history: LlmGatewayMessage[] = [
        {
          role: "user",
          content: "Compare these synthetic observations. Reply ok.",
        },
      ];
      let previous: CacheRequestFingerprint | undefined;
      let previousHistoryAnchor:
        | { version: 1; fingerprint: string }
        | undefined;
      let historyAnchorStatus: string | undefined;
      for (let step = 1; step <= 3; step++) {
        const phase =
          step === 1
            ? "cold"
            : scenario === "compression" && step === 3
              ? "post-compaction"
              : "continuous";
        if (scenario === "compression" && step === 3)
          history = [
            {
              role: "user",
              content:
                "<context-summary>Synthetic completed steps summarized.</context-summary>",
            },
            ...history.slice(-2),
          ];
        if (scenario === "recovery" && step === 3)
          history = JSON.parse(JSON.stringify(history));
        const context: AgentContextBundle | null =
          scenario === "no-reference"
            ? null
            : {
                id: `ctx-${step}`,
                projectId: "fixture",
                sessionId: null,
                nodeId: null,
                profileId: "synax",
                createdAt: "",
                warnings: [],
                citations: [],
                blocks: [
                  {
                    id: `acblk-${step}-map`,
                    kind: "code",
                    title: "Code Map",
                    content: live
                      ? "Synthetic stable input. ".repeat(1200)
                      : "Module alpha calls module beta.",
                    sourceType: "code-map",
                    sourceId: "stable-scan",
                  },
                  {
                    id: `acblk-${step}-wiki`,
                    kind: "wiki",
                    title: "Wiki",
                    content: "Synthetic documentation.",
                    sourceType: "wiki",
                    sourceId: "landscape",
                  },
                ],
              };
        const modeContext = {
          mode: "chat" as const,
          prompt: "Compare synthetic observations",
          metadata:
            scenario === "saved-approved-plan"
              ? {
                  plan: {
                    title: "Synthetic plan",
                    objective: "Compare",
                    revision: 1,
                    status: step === 1 ? "saved" : "approved",
                    acceptanceCriteria: ["Evidence complete"],
                  },
                }
              : {},
        };
        const system = buildLoopSystemPrompt({
          profile: synaxAgentProfile,
          availableToolIds: [],
          context,
          history: [],
          previousParts: [],
          previousToolCalls: [],
          currentPrompt: "Compare",
          maxSteps: 10,
          stepIndex: step,
          modePromptSection: synaxModePromptRegistry.buildSection(
            modeContext as never,
          ),
        });
        const reminder = snapshotRuntimeReminder(
          {},
          [
            `[Step ${step}]`,
            `Work evidence: ${Array.from({ length: step - 1 }, (_, i) => `receipt-${i}`).join(", ")}`,
            buildSynaxRuntimeState(modeContext as never),
          ],
          [],
        );
        const request: LlmGatewayRequest = {
          previousHistoryAnchor,
          onRequestPrepared: (prepared) => {
            previousHistoryAnchor = prepared.historyAnchor;
            historyAnchorStatus = prepared.historyAnchorStatus;
          },
          purpose: "validate",
          model: selection.model,
          cacheControl: true,
          maxTokens: 32,
          responseOptions: { store: false },
          cacheDiagnosticsContext: {
            requestId: `${scenario}-${step}`,
            source: live ? "auxiliary" : "main",
            phase,
          },
          messages: [
            { role: "system", content: system },
            ...history,
            { role: "user", content: reminder.content },
          ],
        };
        const fingerprint = await fingerprintGatewayRequest(request);
        const started = performance.now();
        let result: {
          usage: unknown;
          providerMetadata?: Record<string, any>;
          text: string;
        };
        try {
          result = (await executePipeline(
            request,
            selection,
            { kind: "text" },
            live ? AbortSignal.timeout(60000) : undefined,
          )) as typeof result;
        } catch (error) {
          if (!live) throw error;
          measurements.push({
            provider: selection.providerId,
            model: selection.modelId,
            source: live ? "auxiliary" : "main",
            phase,
            scenario,
            outcome: "failed",
            errorType: error instanceof Error ? error.name : "UnknownError",
            usage: undefined,
            durationMs: performance.now() - started,
            firstTokenMs: null,
            cost: null,
            request: fingerprint,
            comparison: previous
              ? compareRequests(previous, fingerprint)
              : null,
          });
          break; // A failed authorized sample is not retried or recorded as zero usage.
        }
        const normalized = normalizeUsage(result.usage, {
          source: "sdk",
          protocol: selection.apiFormat,
          providerMetadata: result.providerMetadata,
        });
        measurements.push({
          provider: selection.providerId,
          model: selection.modelId,
          source: live ? "auxiliary" : "main",
          phase,
          scenario,
          historyAnchorStatus,
          usage: normalized,
          outcome: "completed",
          durationMs: performance.now() - started,
          firstTokenMs: null,
          cost: null,
          request: fingerprint,
          comparison: previous ? compareRequests(previous, fingerprint) : null,
          ...(!live ? { localWire: wire.at(-1) } : {}),
        });
        if (
          !live &&
          selection.apiFormat === "anthropic" &&
          wire.at(-1)!.markers > 4
        )
          throw new Error("Anthropic marker budget exceeded");
        previous = fingerprint;
        history.push(
          { role: "user", content: reminder.content },
          { role: "assistant", content: result.text },
        );
        if (scenario === "long-history")
          for (let n = 0; n < 24; n++)
            history.push(
              { role: "user", content: `Synthetic observation ${step}-${n}` },
              { role: "assistant", content: `Acknowledged ${step}-${n}` },
            );
      }
    }
  if (!live && !storedSession && !args.includes("--skip-regressions")) {
    const run = spawnSync(
      process.execPath,
      [
        "node_modules/vitest/vitest.mjs",
        "run",
        "api/services/agent-runtime/__tests__/loop-runtime.test.ts",
        "api/services/agent-runtime/__tests__/context-projection.test.ts",
        "-t",
        "prefix-identical|immutable runtime reminders|persistent work context projection|completed conversation follow-ups",
      ],
      { encoding: "utf8", timeout: 120000 },
    );
    regression = {
      status: run.status === 0 ? "passed" : "failed",
      exitCode: run.status,
      scope:
        "Native three-request prefix capture; immutable reminders; queue consumption; real context compression/recovery fixtures",
    };
  }
} finally {
  if (server.listening)
    await new Promise<void>((done, reject) =>
      server.close((error) => (error ? reject(error) : done())),
    );
}
for (const measurement of measurements) {
  const usage = normalizeUsage(measurement.usage);
  measurement.usage = usage
    ? {
        inputTokens: usage.inputTokens,
        outputTokens: usage.outputTokens,
        totalTokens: usage.totalTokens,
        reasoningTokens: usage.reasoningTokens,
        cachedInputTokens: usage.cachedInputTokens,
        cacheWriteTokens: usage.cacheWriteTokens,
        normalization: usage.normalization,
      }
    : undefined;
}
const report = {
  version: 1,
  generatedAt: new Date().toISOString(),
  mode: storedSession
    ? "stored-session-read-only"
    : live
      ? "live-explicit-opt-in"
      : "local-fixture",
  serverCacheMeasurement:
    live || storedSession
      ? "provider-reported-only; unavailable counts remain unknown"
      : "NOT MEASURED: all token usage below is fixture data, not a real cache hit",
  latencyMeaning: storedSession
    ? "recorded adapter timings only; unavailable timings remain unknown"
    : live
      ? "measured provider call duration; text-mode first token unavailable"
      : "local HTTP/SDK overhead only",
  regression,
  liveOutcome: !live
    ? "not-run"
    : measurements.some((m) => m.outcome === "failed")
      ? "failed"
      : "completed",
  groups: await summarizeCacheMeasurements(measurements),
  measurements,
};
await mkdir(outDir, { recursive: true });
await writeFile(
  resolve(outDir, "report.json"),
  JSON.stringify(report, null, 2) + "\n",
);
await writeFile(
  resolve(outDir, "report.md"),
  `# Prompt cache diagnostic report\n\nMode: ${report.mode}\n\n${report.serverCacheMeasurement}\n\nRequests: ${measurements.length}; Native regressions: ${regression.status}.\n\n${report.latencyMeaning}\n\n| Provider | Phase | Requests | Read coverage | Matched input | Cache read ratio |\n|---|---|---:|---:|---:|---:|\n${report.groups.map((g) => `| ${g.provider} | ${g.phase} | ${g.requests} | ${g.cacheReadCoverage} | ${g.matchedInput} | ${g.cacheReadRate ?? "unknown"} |`).join("\n")}\n\nStructured fingerprints, first differing blocks, compression phases and usage availability: report.json. No prompt bodies are included.\n`,
);
console.log(
  JSON.stringify({
    outDir,
    mode: report.mode,
    requests: measurements.length,
    regressions: regression.status,
    realCacheMeasured:
      live &&
      measurements.some(
        (m) =>
          normalizeUsage(m.usage)?.normalization.cacheRead.status === "known",
      ),
  }),
);
if (
  regression.status === "failed" ||
  (live && measurements.some((m) => m.outcome === "failed"))
)
  process.exitCode = 1;
