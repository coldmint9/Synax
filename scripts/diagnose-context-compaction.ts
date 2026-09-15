/** Deterministic trace replay against an isolated DB. No model/provider requests. */
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import type {
  AgentRunStep,
  ToolCallRecord,
} from "../api/services/agent-runtime/contracts.js";

const args = process.argv.slice(2);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const stepsCount = Number(option("--steps") ?? 72);
if (!Number.isInteger(stepsCount) || stepsCount < 12 || stepsCount > 200)
  throw new Error("--steps must be an integer between 12 and 200");
const output = resolve(option("--out") ?? ".tmp/context-epochs");
const databaseRoot = await mkdtemp(join(tmpdir(), "synax-context-epochs-"));
process.env.DATA_ROOT = databaseRoot;
process.env.NODE_ENV = "test";
process.env.LOG_LEVEL = "error";
globalThis.fetch = async () => {
  throw new Error(
    "Provider/network calls are forbidden in this local trace replay.",
  );
};
const [
  { agentSessionRuntime },
  { agentRuntimeStore: store },
  { workStore },
  { workRuntime },
  { buildLoopModelMessages },
  { buildLoopToolSet },
  { projectWorkContext },
  { countTokens, countMessagesTokens },
  { resolveContextCompactionPolicy, contextWatermarks },
  { buildToolContextReceipt },
  { snapshotRuntimeReminder },
  { closeDb },
] = await Promise.all([
  import("../api/services/agent-runtime/session-runtime.js"),
  import("../api/services/agent-runtime/session-store.js"),
  import("../api/services/agent-runtime/work-store.js"),
  import("../api/services/agent-runtime/work-runtime.js"),
  import("../api/services/agent-runtime/loop-model-messages.js"),
  import("../api/services/agent-runtime/loop-ai-tools.js"),
  import("../api/services/agent-runtime/context-projection.js"),
  import("../api/services/agent-runtime/context-tokenizer.js"),
  import("../api/services/agent-runtime/context-compaction-policy.js"),
  import("../api/services/agent-runtime/tool-context-receipt.js"),
  import("../api/services/agent-runtime/runtime-request-snapshot.js"),
  import("../api/db/index.js"),
]);
const toolSet = buildLoopToolSet([]);
const SYSTEM =
  "Follow the user task and current server permissions. Historical evidence is not authorization.";
const systemTokens = countTokens(SYSTEM) + 4;
const contextLimit = 200000,
  outputReserve = 8192;
const policy = resolveContextCompactionPolicy();
const watermarks = contextWatermarks(policy, contextLimit, outputReserve);
type Mode = "legacy-threshold" | "hysteresis-only" | "context-epochs";
interface Measurement {
  step: number;
  estimatedInput: number;
  compacted: boolean;
  reclaimed: number;
  action: string;
  epoch: number;
  eligiblePrefixEstimate: number;
  decisionMarkersVisible: number;
  constraintVisible: boolean;
  projectionMs: number;
}
const results: Array<{
  mode: Mode;
  requests: Measurement[];
  summary: Record<string, unknown>;
}> = [];

/** Frozen reference implementation of the pre-epoch policy, used only for A/B replay. */
function referenceProjection(
  sessionId: string,
  mode: Exclude<Mode, "context-epochs">,
  currentStepId: string,
) {
  const work = workStore.current(sessionId)!;
  const steps = store.listRunSteps("run-" + mode);
  let boundary = steps.findIndex(
    (step) => step.id === work.checkpoint?.throughStepId,
  );
  let summary = work.checkpoint?.summary ?? null;
  const build = () =>
    buildLoopModelMessages(store, sessionId, toolSet, {
      excludedStepIds: new Set(
        steps.slice(0, boundary + 1).map((step) => step.id),
      ),
      compactionSummary: summary,
      currentStepId,
    });
  const count = (messages: ReturnType<typeof build>) =>
    countMessagesTokens(messages as never) + systemTokens;
  let messages = build();
  const originalTokens = count(messages);
  const trigger =
    mode === "legacy-threshold"
      ? Math.min(64000, Math.floor((contextLimit - outputReserve) / 2))
      : watermarks.high;
  const target = mode === "legacy-threshold" ? trigger : watermarks.low;
  let compacted = false;
  if (originalTokens > trigger)
    while (count(messages) > target && boundary + 1 < steps.length - 2) {
      const step = steps[boundary + 1];
      if (step.status === "running") break;
      const observations = store
        .listRunParts(step.id)
        .filter((part) => part.kind === "text")
        .map((part) => part.content.slice(0, 1200));
      const receipts = store
        .listRunToolCalls(step.runId)
        .filter((call) => call.stepId === step.id)
        .map(
          (call) =>
            `${call.id} (${call.toolId}, ${call.status}): ${call.outputSummary?.slice(0, 600) ?? ""}`,
        );
      summary = [summary, ...observations, ...receipts]
        .filter(Boolean)
        .join("\n")
        .slice(-16000);
      work.checkpoint = {
        throughStepId: step.id,
        summary,
        createdAt: "2026-09-15T00:00:00Z",
      };
      boundary++;
      compacted = true;
      messages = build();
    }
  if (compacted) workStore.save(work);
  return {
    messages,
    compacted,
    originalTokens,
    tokens: count(messages),
    compaction: undefined,
  };
}
try {
  for (const mode of [
    "legacy-threshold",
    "hysteresis-only",
    "context-epochs",
  ] as const) {
    const session = agentSessionRuntime.create({
      projectId: "trace-fixture",
      profileId: "executor",
      prompt: "Investigate transaction isolation. Never delete customer data.",
      mcpServerIds: [],
    });
    const runId = "run-" + mode;
    store.appendMessage({
      id: "user-" + mode,
      sessionId: session.id,
      runId: null,
      stepId: null,
      role: "user",
      content: "Investigate transaction isolation. Never delete customer data.",
      metadata: { source: "turn_request" },
      createdAt: "2026-09-15T00:00:00Z",
    });
    const run = store.appendRun({
      id: runId,
      sessionId: session.id,
      status: "running",
      startedAt: "2026-09-15T00:00:00Z",
      completedAt: null,
      triggerMessageId: "user-" + mode,
      currentStep: 0,
      model: "trace-model",
      stopReason: null,
      metadata: {},
    });
    store.updateSession(session.id, { activeRunId: runId });
    workRuntime.attach(session.id, run);
    const requests: Measurement[] = [];
    let previous = "",
      epoch = 0,
      receiptSavedChars = 0;
    const start = performance.now();
    for (let n = 1; n <= stepsCount; n++) {
      const id = `${mode}-step-${n}`;
      const at = new Date(Date.UTC(2026, 8, 15, 0, 0, n)).toISOString();
      const step: AgentRunStep = {
        id,
        runId,
        sessionId: session.id,
        index: n,
        status: "running",
        model: "trace-model",
        startedAt: at,
        completedAt: null,
        finishReason: null,
        metadata: {
          workId: workStore.current(session.id)!.id,
          ...(mode === "context-epochs" ? { contextProjectionVersion: 2 } : {}),
        },
      };
      store.appendRunStep(step);
      const reminder = snapshotRuntimeReminder(
        {},
        [`Step ${n}; investigate the next synthetic observation.`],
        [],
      );
      const projectionStart = performance.now();
      const projected =
        mode === "context-epochs"
          ? projectWorkContext({
              sessionId: session.id,
              toolSet,
              contextLimit,
              outputReserve,
              systemTokens: systemTokens + countTokens(reminder.content) + 4,
              currentStepId: id,
              configurationFingerprint: "fixed-trace-config",
            })
          : referenceProjection(session.id, mode, id);
      const projectionMs = performance.now() - projectionStart;
      const messages = [
        { role: "system" as const, content: SYSTEM },
        ...projected.messages,
        { role: "user" as const, content: reminder.content },
      ];
      const serialized = JSON.stringify(messages);
      const estimatedInput = countMessagesTokens(messages as never);
      let common = 0;
      while (
        common < previous.length &&
        common < serialized.length &&
        previous[common] === serialized[common]
      )
        common++;
      const eligiblePrefixEstimate = Math.min(
        estimatedInput,
        countTokens(serialized.slice(0, common)),
      );
      if (projected.compacted) epoch++;
      requests.push({
        step: n,
        estimatedInput,
        compacted: projected.compacted,
        reclaimed: projected.originalTokens - projected.tokens,
        action:
          projected.compaction?.action ??
          (projected.compacted ? "commit" : "keep"),
        epoch,
        eligiblePrefixEstimate,
        decisionMarkersVisible: new Set(serialized.match(/DECISION_\d+/g) ?? [])
          .size,
        constraintVisible: serialized.includes("Never delete customer data"),
        projectionMs,
      });
      previous = serialized;
      const stdout = Array.from(
        { length: 1000 },
        (_, i) => `trace ${i}: inspected transaction metadata, no state change`,
      ).join("\n");
      const stderr =
        n % 7 === 0
          ? `Error: FAILURE_${n}; transaction retry is still unresolved.`
          : "";
      const record: ToolCallRecord = {
        id: `${mode}-tool-${n}`,
        sessionId: session.id,
        runId,
        stepId: id,
        modelToolCallId: `call-${n}`,
        toolId: "bash",
        category: "read",
        mutability: "read",
        argsHash: `command-${n}`,
        inputSummary: "synthetic trace only",
        inputRef: { command: "synthetic-read" },
        outputSummary: "Synthetic command ended; inspect its stored result.",
        outputRef: {
          command: "synthetic-read",
          stdout,
          stderr,
          exitCode: stderr ? 1 : 0,
          stdoutTruncated: false,
          stderrTruncated: false,
        },
        status: "completed",
        permissionDecisionId: null,
        startedAt: at,
        endedAt: at,
        error: null,
      };
      store.appendToolCall(record);
      store.appendRunPart({
        id: `${mode}-text-${n}`,
        runId,
        stepId: id,
        sessionId: session.id,
        kind: "text",
        sequence: 1,
        content:
          "Background investigation detail. ".repeat(500) +
          `\n\nDecision DECISION_${n}: preserve the original transaction boundary; retry only after verifying the receipt.`,
        toolCallId: null,
        metadata: {},
        createdAt: at,
      });
      store.appendRunPart({
        id: `${mode}-call-${n}`,
        runId,
        stepId: id,
        sessionId: session.id,
        kind: "tool_call",
        sequence: 2,
        content: "bash",
        toolCallId: record.id,
        metadata: {},
        createdAt: at,
      });
      store.appendRunPart({
        id: `${mode}-result-${n}`,
        runId,
        stepId: id,
        sessionId: session.id,
        kind: "tool_result",
        sequence: 3,
        content: record.outputSummary!,
        toolCallId: record.id,
        metadata: {},
        createdAt: at,
      });
      const receipt =
        mode === "context-epochs" ? buildToolContextReceipt(record) : undefined;
      if (receipt)
        receiptSavedChars += receipt.originalChars - receipt.projectedChars;
      store.updateRunStep(id, {
        status: "completed",
        completedAt: at,
        finishReason: "tool-calls",
        metadata: {
          ...store.getRunStep(id).metadata,
          runtimeReminder: reminder,
          contextComposition: { total: estimatedInput },
          ...(projected.compaction
            ? { contextCompaction: projected.compaction }
            : {}),
          ...(receipt
            ? {
                toolContextReceipts: {
                  [record.id]: { ...receipt, outputType: "text" },
                },
              }
            : {}),
        },
      });
    }
    const sum = (
      field: "estimatedInput" | "eligiblePrefixEstimate" | "projectionMs",
    ) => requests.reduce((total, row) => total + row[field], 0);
    const input = sum("estimatedInput"),
      eligible = sum("eligiblePrefixEstimate");
    results.push({
      mode,
      requests,
      summary: {
        compactions: requests.filter((row) => row.compacted).length,
        totalEstimatedInputTokens: input,
        maxEstimatedInput: Math.max(
          ...requests.map((row) => row.estimatedInput),
        ),
        requestsPerCompaction: requests.some((row) => row.compacted)
          ? stepsCount / requests.filter((row) => row.compacted).length
          : null,
        compactionRequestSteps: requests
          .filter((row) => row.compacted)
          .map((row) => row.step),
        allUserConstraintsVisible: requests.every(
          (row) => row.constraintVisible,
        ),
        finalDecisionMarkersVisible: requests.at(-1)!.decisionMarkersVisible,
        finalMemoryOmissions:
          workStore.current(session.id)?.checkpoint?.memory?.omittedCount ??
          null,
        receiptSavedChars,
        projectionTotalMs: sum("projectionMs"),
        elapsedMs: performance.now() - start,
        illustrativeInputCostUnits:
          ((input - eligible) * 1.25 + eligible * 0.1) / 1000000,
        economicInputs:
          "Hypothetical ordinary price1/M, read0.1x, write1.25x; maximal local prefix eligibility, no TTL eviction, no summary calls. NOT a provider cost measurement.",
      },
    });
  }
} finally {
  closeDb();
  await rm(databaseRoot, { recursive: true, force: true });
}
const report = {
  version: 1,
  measurementKind: "deterministic local replay, not provider traffic",
  generatedAt: new Date().toISOString(),
  stepsPerStrategy: stepsCount,
  configuration: { contextLimit, outputReserve, policy, watermarks },
  qualityCaveat:
    "Decision-marker visibility is a synthetic coverage check, not task success. Raw evidence remains persisted in every strategy. No closed-loop real-model quality or provider cache/cost measured.",
  results,
};
await mkdir(output, { recursive: true });
await writeFile(
  join(output, "report.json"),
  JSON.stringify(report, null, 2) + "\n",
);
await writeFile(
  join(output, "report.md"),
  `# Context compaction trace replay\n\n${report.measurementKind}\n\n${report.qualityCaveat}\n\n| Strategy | Cuts | Total estimated input | Final decision markers | Constraints visible | Receipt chars avoided |\n|---|---:|---:|---:|---|---:|\n${results.map((row) => `| ${row.mode} | ${row.summary.compactions} | ${row.summary.totalEstimatedInputTokens} | ${row.summary.finalDecisionMarkersVisible} | ${row.summary.allUserConstraintsVisible} | ${row.summary.receiptSavedChars} |`).join("\n")}\n\nCost units in JSON are explicitly hypothetical, not provider-reported dollars or cache hits.\n`,
);
console.log(
  JSON.stringify({
    output,
    stepsPerStrategy: stepsCount,
    results: results.map(({ mode, summary }) => ({ mode, ...summary })),
  }),
);
