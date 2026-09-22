import { goalContinuationInput } from "../goal-continuation.js";
import os from "node:os";
import { applySessionPermissionUpdate } from "../session-permissions.js";
import { inspectHistoryCacheAnchor } from "../../llm-runtime/cache-policy.js";
import { asSchema } from "@ai-sdk/provider-utils";
import { resolveGatewaySelection } from "../../llm-runtime/gateway.js";
import { buildSessionPrompt } from "../session-prompt.js";
import { workStore } from "../work-store.js";
import { acceptRuntimeRun } from "../run-admission.js";
import fs from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

type MockStreamEvent =
  | { type: "text-delta"; text: string; id?: string }
  | { type: "reasoning-delta"; text: string; id?: string }
  | {
      type: "tool-call";
      toolCallId: string | number;
      toolName: string;
      input: unknown;
    }
  | {
      type: "finish-step";
      finishReason: string;
      usage?: Record<string, unknown>;
      providerMetadata?: Record<string, unknown>;
    }
  | {
      type: "finish";
      finishReason: string;
      totalUsage?: Record<string, unknown>;
    };

function makeStream(events: MockStreamEvent[]) {
  return {
    fullStream: (async function* () {
      yield* events;
    })(),
  };
}

const capturedRequests: Array<{
  messages: Array<{ role: string; content: unknown }>;
  tools: string[];
  definitions: unknown[];
  reasoningEffort?: string;
}> = [];

const mockStepResults: Array<{
  contentParts?: import("../content-parts.js").RuntimeContentPart[];
  fullStream: AsyncIterable<MockStreamEvent>;
  tools?: { resolveToolId: (name: string) => string | undefined };
  mustFinalize?: boolean;
  model?: string | null;
}> = [];

/**
 * Minimal JSON shorthand parser for tests. Extracts { "tool": "...", "args": {...} }
 * from the beginning of text, matching the real parseLoopModelStepText behavior.
 */
function parseJsonToolShorthand(
  text: string,
): { toolId: string; args: Record<string, unknown>; message?: string } | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("{")) return null;

  // Find the matching closing brace
  let depth = 0;
  let inString = false;
  let escaped = false;
  let endIndex = -1;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (ch === "{") {
      depth++;
      continue;
    }
    if (ch === "}") {
      depth--;
      if (depth === 0) {
        endIndex = i;
        break;
      }
    }
  }
  if (endIndex === -1) return null;

  try {
    const jsonStr = trimmed.slice(0, endIndex + 1);
    const parsed = JSON.parse(jsonStr);
    if (!parsed || typeof parsed !== "object") return null;
    const toolId =
      typeof parsed.toolId === "string"
        ? parsed.toolId
        : typeof parsed.tool === "string"
          ? parsed.tool
          : null;
    if (!toolId) return null;
    const args =
      parsed.args &&
      typeof parsed.args === "object" &&
      !Array.isArray(parsed.args)
        ? (parsed.args as Record<string, unknown>)
        : {};
    const trailing = trimmed.slice(endIndex + 1).trim();
    return { toolId, args, message: trailing || undefined };
  } catch {
    return null;
  }
}

/**
 * Mock for streamLoopModelStep — processes mock stream events the same way the
 * real implementation does, yielding text_delta / thought_delta / step_complete.
 */
async function* mockStreamLoopModelStep(input: {
  request?: {
    messages: Array<{ role: string; content: unknown }>;
    reasoningEffort?: string;
    previousHistoryAnchor?: { version: 1; fingerprint: string };
    onRequestPrepared?: import("../../llm-runtime/types.js").LlmGatewayRequest["onRequestPrepared"];
  };
  tools: { resolveToolId: (name: string) => string | undefined };
  mustFinalize?: boolean;
  model?: string | null;
}): AsyncGenerator<{
  type: string;
  delta?: string;
  step?: {
    contentParts?: import("../content-parts.js").RuntimeContentPart[];
    thought?: string;
    message?: string;
    toolCalls: Array<{
      id: string;
      toolId: string;
      args: Record<string, unknown>;
    }>;
    final: boolean;
    stopReason: string | null;
    finishReason: string | null;
    usage?: Record<string, unknown>;
    providerMetadata?: Record<string, unknown>;
  };
  model?: string | null;
}> {
  if (input.request?.onRequestPrepared) {
    const messages = input.request
      .messages as import("../../llm-runtime/types.js").LlmGatewayMessage[];
    await input.request.onRequestPrepared({
      messages,
      ...inspectHistoryCacheAnchor(
        messages,
        input.request.previousHistoryAnchor,
      ),
    });
  }
  if (input.request)
    capturedRequests.push({
      messages: structuredClone(input.request.messages),
      reasoningEffort: input.request.reasoningEffort,
      tools: [
        ...((input.tools as { activeTools?: string[] }).activeTools ?? []),
      ],
      definitions: await Promise.all(
        Object.entries(
          (input.tools as unknown as { tools?: import("ai").ToolSet }).tools ??
            {},
        ).map(async ([name, tool]) => ({
          name,
          description: tool.description,
          inputSchema: await asSchema(tool.inputSchema).jsonSchema,
        })),
      ),
    });
  const data = mockStepResults.shift();
  if (!data)
    throw new Error("No mock step data queued — call queueMockStep() first.");

  let text = "";
  let thought = "";
  let finishReason: string | null = null;
  let usage: Record<string, unknown> | undefined;
  let providerMetadata: Record<string, unknown> | undefined;
  const toolCalls: Array<{
    id: string;
    toolId: string;
    args: Record<string, unknown>;
  }> = [];

  for await (const event of data.fullStream) {
    switch (event.type) {
      case "text-delta":
        text += event.text;
        yield { type: "text_delta", delta: event.text };
        break;
      case "reasoning-delta":
        thought += event.text;
        yield { type: "thought_delta", delta: event.text };
        break;
      case "tool-call": {
        const toolId =
          input.tools.resolveToolId(event.toolName) ?? event.toolName;
        toolCalls.push({
          id:
            typeof event.toolCallId === "number"
              ? String(event.toolCallId)
              : event.toolCallId,
          toolId,
          args:
            event.input && typeof event.input === "object"
              ? (event.input as Record<string, unknown>)
              : {},
        });
        break;
      }
      case "finish-step":
        finishReason = event.finishReason;
        usage = event.usage;
        providerMetadata = event.providerMetadata;
        break;
      case "finish":
        finishReason ??= event.finishReason;
        usage ??= event.totalUsage;
        break;
    }
  }

  // JSON shorthand fallback: if no structured tool calls, try parsing text as JSON
  let finalMessage: string | undefined = text.trim() || undefined;
  let finalToolCalls = toolCalls.filter(
    (c) => !c.toolId.includes("multi_tool_use"),
  );

  if (!data.mustFinalize && finalToolCalls.length === 0 && finalMessage) {
    const shorthand = parseJsonToolShorthand(finalMessage);
    if (shorthand) {
      finalToolCalls = [
        {
          id: `mtc_fallback_1`,
          toolId:
            input.tools.resolveToolId(shorthand.toolId) ?? shorthand.toolId,
          args: shorthand.args,
        },
      ];
      finalMessage = shorthand.message || undefined;
    }
  }

  if (data.mustFinalize) finalToolCalls = [];

  yield {
    type: "step_complete",
    step: {
      contentParts: data.contentParts,
      thought: thought.trim() || undefined,
      message: text.trim() || undefined,
      toolCalls: finalToolCalls,
      final: data.mustFinalize || finalToolCalls.length === 0,
      stopReason: data.mustFinalize ? "max_steps" : null,
      finishReason: data.mustFinalize ? "max_steps" : finishReason,
      usage,
      providerMetadata,
    },
    model: data.model ?? input.model ?? null,
  };
}

function queueMockStep(
  stream: ReturnType<typeof makeStream>,
  opts?: {
    mustFinalize?: boolean;
    model?: string | null;
    contentParts?: import("../content-parts.js").RuntimeContentPart[];
  },
) {
  mockStepResults.push({
    fullStream: stream.fullStream,
    contentParts: opts?.contentParts,
    mustFinalize: opts?.mustFinalize,
    model: opts?.model,
  });
}

function makeTextStep(message: string): ReturnType<typeof makeStream> {
  return makeStream([
    { type: "text-delta", id: "txt", text: message },
    { type: "finish-step", finishReason: "stop", usage: {} },
    { type: "finish", finishReason: "stop", totalUsage: {} },
  ]);
}

function makeToolStep(input: {
  message?: string;
  toolName: string;
  toolCallId: string | number;
  args: Record<string, unknown>;
}): ReturnType<typeof makeStream> {
  return makeStream([
    ...(input.message
      ? [{ type: "text-delta" as const, id: "txt", text: input.message }]
      : []),
    {
      type: "tool-call",
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      input: input.args,
    },
    { type: "finish-step", finishReason: "tool-calls", usage: {} },
    { type: "finish", finishReason: "tool-calls", totalUsage: {} },
  ]);
}

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

vi.mock("../loop-model-stream.js", () => ({
  streamLoopModelStep: (input: unknown) =>
    mockStreamLoopModelStep(
      input as Parameters<typeof mockStreamLoopModelStep>[0],
    ),
  generateLoopModelStep: vi
    .fn()
    .mockRejectedValue(new Error("generateLoopModelStep not mocked")),
}));

vi.mock("../context-tokenizer.js", () => ({
  countTokens: vi.fn().mockReturnValue(100),
  countMessagesTokens: vi.fn().mockReturnValue(500),
  estimateToolDefinitionsTokens: vi.fn().mockReturnValue(50),
}));

// Prevent resolveGatewaySelection from trying real LLM resolution
vi.mock("../../llm-runtime/gateway.js", () => ({
  resolveGatewaySelection: vi
    .fn()
    .mockRejectedValue(new Error("not configured in test")),
}));

import { ensureSynaxAgentRegistered } from "../synax/index.js";
import { interactionService } from "../interaction-service.js";
import { agentLoopRuntime } from "../loop-runtime.js";
import { inputQueueService } from "../input-queue-service.js";
import type { AgentRunStreamChunk } from "../contracts.js";
import { permissionPolicy } from "../permission-policy.js";
import { skillRegistry } from "../../skills/skill-registry.js";
import { resolveSessionWorkspaceRoots } from "../tools/workspace.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore } from "../session-store.js";
import {
  executorInput,
  resetAgentRuntimeFixtures,
} from "./agent-runtime-fixtures.js";
import { API_SESSION_LOG_FILE } from "../../../lib/logger.js";

async function collectChunks<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const chunks: T[] = [];
  for await (const chunk of iterable) chunks.push(chunk);
  return chunks;
}

describe("agentLoopRuntime", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStepResults.length = 0;
    resetAgentRuntimeFixtures();
    fs.rmSync(path.resolve("tmp/agent-loop-runtime-read.txt"), { force: true });
    fs.rmSync(path.resolve("tmp/agent-loop-runtime-write.txt"), {
      force: true,
    });
    fs.writeFileSync(API_SESSION_LOG_FILE, "", "utf8");
  });

  it("captures native input and reply boundaries and restores the exact earlier turn", async () => {
    const { listCheckpoints } = await import("../checkpoints/store.js");
    const { applyHistory } = await import("../checkpoints/operations.js");
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "synax-native-history-"),
    );
    try {
      const session = agentSessionRuntime.create({
        ...executorInput,
        workDir: directory,
      });
      queueMockStep(makeTextStep("First answer."));
      await collectChunks(
        agentLoopRuntime.streamRun(session.id, { message: "First question" }),
      );
      const checkpoint = listCheckpoints(session.id).find(
        (c) => c.kind === "reply",
      )!;
      expect(checkpoint.payload.version).toBe(2);
      queueMockStep(makeTextStep("Second answer."));
      await collectChunks(
        agentLoopRuntime.streamRun(session.id, { message: "Second question" }),
      );
      expect(listCheckpoints(session.id).map((c) => c.kind)).toEqual([
        "input",
        "reply",
        "input",
        "reply",
      ]);
      await applyHistory(session.id, {
        action: "rollback",
        checkpointId: checkpoint.id,
        revision: 0,
        requestId: "native-rollback",
      });
      const text = agentRuntimeStore
        .listMessages(session.id)
        .map((m) => m.content)
        .join("\n");
      expect(text).toContain("First question");
      expect(text).toContain("First answer.");
      expect(text).not.toContain("Second question");
      expect(text).not.toContain("Second answer.");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("completes a media-only response and persists its attachment for the timeline", async () => {
    const { createAsset, readAsset } = await import("../media-assets.js");
    const session = agentSessionRuntime.create({
      ...executorInput,
      workDir: process.cwd(),
    });
    const bytes = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
      "base64",
    );
    const asset = await createAsset(
      session.projectId,
      "output.png",
      bytes,
      "image/png",
    );
    queueMockStep(makeTextStep(""), {
      contentParts: [{ type: "image", assetId: asset.id }],
    });
    const chunks = await collectChunks(
      agentLoopRuntime.streamRun(session.id, { message: "Generate an image." }),
    );
    expect(chunks.some((chunk) => chunk.type === "done")).toBe(true);
    expect(agentRuntimeStore.listRuns(session.id)[0].status).toBe("completed");
    expect(
      agentRuntimeStore
        .listMessages(session.id)
        .some(
          (message) =>
            message.role === "assistant" &&
            message.contentParts?.some(
              (part) => part.type === "image" && part.assetId === asset.id,
            ),
        ),
    ).toBe(true);
    expect(await readAsset(asset.id)).toEqual(bytes);
  });

  it("uses the durable accepted Run instead of allocating a second Native Run", async () => {
    queueMockStep(makeTextStep("Accepted task finished."));
    const session = agentSessionRuntime.create({
      ...executorInput,
      workDir: process.cwd(),
    });
    const accepted = acceptRuntimeRun(
      session.id,
      { message: "Do the task" },
      "native-admission",
    );
    const chunks = await collectChunks(
      agentLoopRuntime.streamRun(session.id, {
        message: "Do the task",
        acceptedRunId: accepted.run.id,
      }),
    );
    expect(agentRuntimeStore.listRuns(session.id)).toHaveLength(1);
    expect(agentRuntimeStore.getRun(accepted.run.id).status).toBe("completed");
    expect(chunks.find((chunk) => chunk.type === "run_started")).toMatchObject({
      run: { id: accepted.run.id },
    });
  });

  it("persists a multi-step read tool loop with run-step transcript parts", async () => {
    const readPath = "tmp/agent-loop-runtime-read.txt";
    fs.mkdirSync(path.dirname(path.resolve(readPath)), { recursive: true });
    fs.writeFileSync(path.resolve(readPath), "loop runtime file", "utf8");
    queueMockStep(
      makeToolStep({
        message: "I need to inspect the file first.",
        toolName: "file_read",
        toolCallId: "call-read",
        args: { path: readPath },
      }),
    );
    queueMockStep(makeTextStep("The file contents were read successfully."));

    const session = agentSessionRuntime.create(executorInput);
    const chunks = await collectChunks(
      agentLoopRuntime.streamRun(session.id, {
        message: "Inspect the temp file.",
      }),
    );

    expect(
      chunks.some((chunk) => (chunk as { type?: string }).type === "tool_call"),
    ).toBe(true);
    expect(
      chunks.some(
        (chunk) => (chunk as { type?: string }).type === "tool_result",
      ),
    ).toBe(true);
    expect(
      agentLoopRuntime
        .listMessages(session.id)
        .map((message) => `${message.role}:${message.content}`),
    ).toEqual([
      "user:Inspect the temp file.",
      "assistant:I need to inspect the file first.",
      "assistant:The file contents were read successfully.",
    ]);

    const [run] = agentLoopRuntime.listRuns(session.id);
    const steps = agentLoopRuntime.listRunSteps(session.id, run.id);
    expect(steps).toHaveLength(2);

    const firstStepParts = agentRuntimeStore.listRunParts(steps[0].id);
    expect(firstStepParts.map((part) => part.kind)).toEqual([
      "text",
      "tool_call",
      "tool_result",
    ]);
    const [toolCall] = agentRuntimeStore.listToolCalls(session.id);
    expect(
      firstStepParts.find((part) => part.kind === "tool_call")?.toolCallId,
    ).toBe(toolCall.id);
    expect(
      firstStepParts.find((part) => part.kind === "tool_result")?.toolCallId,
    ).toBe(toolCall.id);
    expect(toolCall.status).toBe("completed");

    const logText = fs.readFileSync(API_SESSION_LOG_FILE, "utf8");
    expect(logText).toContain("[agent-runtime] run starting");
    expect(logText).toContain("[agent-runtime] tool call executed");
    expect(logText).toContain("[agent-runtime] model step completed");
  });

  it("repairs OpenCode-style tool JSON followed by assistant text", async () => {
    queueMockStep(
      makeTextStep(
        '{"tool":"file.read","args":{"path":"package.json"}}I am reading package.json now.',
      ),
    );
    queueMockStep(makeTextStep("package.json was read and summarized."));

    const session = agentSessionRuntime.create(executorInput);
    const chunks = await collectChunks(
      agentLoopRuntime.streamRun(session.id, {
        message: "Read package.json and summarize it.",
      }),
    );

    expect(
      chunks.some((chunk) => (chunk as { type?: string }).type === "tool_call"),
    ).toBe(true);
    expect(
      chunks.some(
        (chunk) => (chunk as { type?: string }).type === "tool_result",
      ),
    ).toBe(true);

    const [toolCall] = agentRuntimeStore.listToolCalls(session.id);
    expect(toolCall.toolId).toBe("file.read");
    expect(toolCall.status).toBe("completed");
    expect(toolCall.inputRef).toEqual({ path: "package.json" });
    expect(agentLoopRuntime.listMessages(session.id).at(-1)?.content).toBe(
      "package.json was read and summarized.",
    );

    expect(agentLoopRuntime.listRuns(session.id)[0]?.status).toBe("completed");
  });

  it("normalizes numeric tool call ids before reusing them in later turns", async () => {
    queueMockStep(
      makeToolStep({
        message: "I need to inspect the file first.",
        toolName: "file_read",
        toolCallId: 123 as any,
        args: { path: "package.json" },
      }),
    );
    queueMockStep(makeTextStep("package.json was read and summarized."));

    const session = agentSessionRuntime.create(executorInput);
    await collectChunks(
      agentLoopRuntime.streamRun(session.id, {
        message: "Read package.json and summarize it.",
      }),
    );

    const [toolCall] = agentRuntimeStore.listToolCalls(session.id);
    expect(toolCall.modelToolCallId).toBe("123");
    expect(typeof toolCall.modelToolCallId).toBe("string");
    expect(agentLoopRuntime.listMessages(session.id).at(-1)?.content).toBe(
      "package.json was read and summarized.",
    );
  });

  it("resumes an approved pending write tool and continues the original run", async ({
    onTestFinished,
  }) => {
    // The approval test owns its workspace. Concurrent checkout edits must not
    // change the evidence or trigger an extra model step in this fixture.
    const workDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "synax-loop-approved-write-"),
    );
    onTestFinished(() => fs.rmSync(workDir, { recursive: true, force: true }));
    capturedRequests.length = 0;
    const writePath = "tmp/agent-loop-runtime-write.txt";
    queueMockStep(
      makeToolStep({
        message: "I need approval before writing the file.",
        toolName: "file_write",
        toolCallId: "call-write",
        args: { path: writePath, content: "hello" },
      }),
    );
    queueMockStep(
      makeToolStep({
        toolName: "bash",
        toolCallId: "verify-write",
        args: {
          command: `node -e "if(require('fs').readFileSync('${writePath}','utf8')!=='hello')process.exit(1)"`,
          criterion: "Requested file content",
          purpose: "Read back the written file",
          scope: [writePath],
        },
      }),
    );
    queueMockStep(makeTextStep("Write complete."));

    const session = agentSessionRuntime.create({ ...executorInput, workDir });
    const firstPass = await collectChunks(
      agentLoopRuntime.streamRun(session.id, { message: "Write the file." }),
    );
    expect(
      firstPass.some(
        (chunk) => (chunk as { type?: string }).type === "permission_requested",
      ),
    ).toBe(true);

    const [permission] = permissionPolicy.list(session.id);
    permissionPolicy.reply(session.id, permission.id, "once");
    await agentLoopRuntime.resumeRun(session.id);
    const verificationPermission = permissionPolicy
      .list(session.id)
      .find(
        (p) => p.id !== permission.id && p.action === "ask" && !p.resolvedAt,
      );
    expect(verificationPermission).toBeTruthy();
    permissionPolicy.reply(session.id, verificationPermission!.id, "once");
    await agentLoopRuntime.resumeRun(session.id);

    expect(fs.readFileSync(path.join(workDir, writePath), "utf8")).toBe(
      "hello",
    );
    expect(agentLoopRuntime.listRuns(session.id)).toHaveLength(1);

    const [run] = agentLoopRuntime.listRuns(session.id);
    const steps = agentLoopRuntime.listRunSteps(session.id, run.id);
    expect(steps).toHaveLength(3);
    expect(run.status).toBe("completed");
    expect(capturedRequests).toHaveLength(3);
    expect(mockStepResults).toHaveLength(0);
    const work = workStore.current(session.id)!;
    expect(work.status).toBe("completed");
    // Main separates chat tool execution from goal acceptance receipts. The
    // real shell read-back succeeds, but must not invent a goal verification.
    expect(work.verifications).toHaveLength(0);
    expect(
      agentRuntimeStore
        .listToolCalls(session.id)
        .find((call) => call.toolId === "bash"),
    ).toMatchObject({ status: "completed", error: null });
    expect(
      capturedRequests.every(
        (request) => !request.tools.includes("verification_run"),
      ),
    ).toBe(true);

    const firstStepParts = agentRuntimeStore.listRunParts(steps[0].id);
    expect(firstStepParts.map((part) => part.kind)).toEqual([
      "text",
      "tool_call",
      "system_note",
      "tool_result",
    ]);

    const [toolCall] = agentRuntimeStore.listToolCalls(session.id);
    expect(toolCall.status).toBe("completed");
    expect(
      firstStepParts.find((part) => part.kind === "tool_result")?.toolCallId,
    ).toBe(toolCall.id);
    expect(agentLoopRuntime.listMessages(session.id).at(-1)?.content).toBe(
      "Write complete.",
    );
  });

  it("waits for task.run child completion and injects the child summary into the parent tool result", async () => {
    queueMockStep(
      makeToolStep({
        message: "I am delegating this as a read-only subtask.",
        toolName: "subagent_delegate",
        toolCallId: "call-task",
        args: {
          profileId: "explorer",
          prompt: "Inspect the module and summarize the result.",
        },
      }),
    );
    queueMockStep(
      makeTextStep("Child summary: the module is read-only and safe."),
    );
    queueMockStep(makeTextStep("Parent run complete after child summary."));

    const session = agentSessionRuntime.create(executorInput);
    agentRuntimeStore.updateSession(session.id, {
      permissionRules: [
        ...session.permissionRules,
        {
          gate: "task",
          pattern: "*",
          action: "allow",
          reason: "Test allows task delegation.",
        },
      ],
    });
    await collectChunks(
      agentLoopRuntime.streamRun(session.id, {
        message: "Delegate a bounded check.",
      }),
    );

    const childSessions = agentRuntimeStore
      .listSessions({ projectId: executorInput.projectId })
      .filter((candidate) => candidate.parentSessionId === session.id);
    expect(childSessions).toHaveLength(1);
    expect(childSessions[0]?.status).toBe("completed");
    expect(childSessions[0]?.resultSummary).toBe(
      "Child summary: the module is read-only and safe.",
    );

    const [taskCall] = agentRuntimeStore
      .listToolCalls(session.id)
      .filter((call) => call.toolId === "subagent.delegate");
    expect(taskCall.outputSummary).toContain(childSessions[0]!.id);
    expect(taskCall.outputSummary).toContain(
      "Child summary: the module is read-only and safe.",
    );
    expect((taskCall.outputRef as { childSummary?: string }).childSummary).toBe(
      "Child summary: the module is read-only and safe.",
    );
    expect(agentLoopRuntime.listMessages(session.id).at(-1)?.content).toBe(
      "Parent run complete after child summary.",
    );
  });

  it("executes multiple read tools in parallel within a single step", async () => {
    const readPath = "tmp/agent-loop-runtime-read.txt";
    fs.mkdirSync(path.dirname(path.resolve(readPath)), { recursive: true });
    fs.writeFileSync(path.resolve(readPath), "parallel read test", "utf8");

    // Single step with 3 read tool calls — all should execute in parallel
    queueMockStep(
      makeStream([
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "file_read",
          input: { path: readPath },
        },
        {
          type: "tool-call",
          toolCallId: "call-2",
          toolName: "file_list",
          input: { path: "tmp" },
        },
        {
          type: "tool-call",
          toolCallId: "call-3",
          toolName: "file_glob",
          input: { pattern: "*.txt" },
        },
        { type: "finish-step", finishReason: "tool-calls", usage: {} },
        { type: "finish", finishReason: "tool-calls", totalUsage: {} },
      ]),
    );
    queueMockStep(makeTextStep("All reads completed."));

    const session = agentSessionRuntime.create(executorInput);
    const chunks = await collectChunks(
      agentLoopRuntime.streamRun(session.id, {
        message: "Run three reads in parallel.",
      }),
    );

    const toolCallChunks = chunks.filter(
      (chunk) => (chunk as { type?: string }).type === "tool_call",
    );
    const toolResultChunks = chunks.filter(
      (chunk) => (chunk as { type?: string }).type === "tool_result",
    );
    expect(toolCallChunks).toHaveLength(3);
    expect(toolResultChunks).toHaveLength(3);

    const allToolCalls = agentRuntimeStore.listToolCalls(session.id);
    expect(allToolCalls).toHaveLength(3);
    expect(allToolCalls.every((call) => call.status === "completed")).toBe(
      true,
    );

    const toolIds = allToolCalls.map((call) => call.toolId).sort();
    expect(toolIds).toEqual(["file.glob", "file.list", "file.read"]);

    // Verify results are in model order (the order in allCalls)
    const [run] = agentLoopRuntime.listRuns(session.id);
    const steps = agentLoopRuntime.listRunSteps(session.id, run.id);
    const firstStepParts = agentRuntimeStore.listRunParts(steps[0].id);
    const toolCallPartIds = firstStepParts
      .filter((part) => part.kind === "tool_call")
      .map((part) => part.toolCallId);
    expect(toolCallPartIds).toEqual(allToolCalls.map((call) => call.id));
  });

  it("executes mixed read and write tools in parallel within a single step", async () => {
    const readPath = "tmp/agent-loop-runtime-read.txt";
    const writePath = "tmp/agent-loop-runtime-write.txt";
    fs.mkdirSync(path.dirname(path.resolve(readPath)), { recursive: true });
    fs.writeFileSync(path.resolve(readPath), "mixed test", "utf8");

    // Allow writes to avoid permission pause
    const session = agentSessionRuntime.create(executorInput);
    agentRuntimeStore.updateSession(session.id, {
      permissionRules: [
        ...session.permissionRules,
        {
          gate: "write",
          pattern: "*",
          action: "allow",
          reason: "Test allows writes.",
        },
      ],
    });

    queueMockStep(
      makeStream([
        {
          type: "tool-call",
          toolCallId: "call-read",
          toolName: "file_read",
          input: { path: readPath },
        },
        {
          type: "tool-call",
          toolCallId: "call-write",
          toolName: "file_write",
          input: { path: writePath, content: "mixed parallel" },
        },
        { type: "finish-step", finishReason: "tool-calls", usage: {} },
        { type: "finish", finishReason: "tool-calls", totalUsage: {} },
      ]),
    );
    queueMockStep(makeTextStep("Read and write both done."));

    const chunks = await collectChunks(
      agentLoopRuntime.streamRun(session.id, {
        message: "Read and write in one step.",
      }),
    );

    const toolCallChunks = chunks.filter(
      (chunk) => (chunk as { type?: string }).type === "tool_call",
    );
    const toolResultChunks = chunks.filter(
      (chunk) => (chunk as { type?: string }).type === "tool_result",
    );
    expect(toolCallChunks).toHaveLength(2);
    expect(toolResultChunks).toHaveLength(2);

    const allToolCalls = agentRuntimeStore.listToolCalls(session.id);
    expect(allToolCalls).toHaveLength(2);
    expect(allToolCalls.every((call) => call.status === "completed")).toBe(
      true,
    );

    expect(fs.readFileSync(path.resolve(writePath), "utf8")).toBe(
      "mixed parallel",
    );
  });

  it("pauses at the first permission ask and emits results for tools before it", async () => {
    const readPath = "tmp/agent-loop-runtime-read.txt";
    const writePath = "tmp/agent-loop-runtime-write.txt";
    fs.mkdirSync(path.dirname(path.resolve(readPath)), { recursive: true });
    fs.writeFileSync(path.resolve(readPath), "permission test", "utf8");

    // Step: read → write (needs permission) → read
    // The read before the write should complete and emit, the write should pause,
    // and the read after should NOT execute (its tool_call is emitted but no result)
    queueMockStep(
      makeStream([
        {
          type: "tool-call",
          toolCallId: "call-read-1",
          toolName: "file_read",
          input: { path: readPath },
        },
        {
          type: "tool-call",
          toolCallId: "call-write",
          toolName: "file_write",
          input: { path: writePath, content: "should not write yet" },
        },
        {
          type: "tool-call",
          toolCallId: "call-read-2",
          toolName: "file_list",
          input: { path: "tmp" },
        },
        { type: "finish-step", finishReason: "tool-calls", usage: {} },
        { type: "finish", finishReason: "tool-calls", totalUsage: {} },
      ]),
    );

    const session = agentSessionRuntime.create(executorInput);
    const chunks = await collectChunks(
      agentLoopRuntime.streamRun(session.id, {
        message: "Read, write, read in one step.",
      }),
    );

    // Should have asked for permission
    expect(
      chunks.some(
        (chunk) => (chunk as { type?: string }).type === "permission_requested",
      ),
    ).toBe(true);

    // All 3 tool_call events should be emitted
    const toolCallChunks = chunks.filter(
      (chunk) => (chunk as { type?: string }).type === "tool_call",
    );
    expect(toolCallChunks).toHaveLength(3);

    // Only the first read's tool_result should be emitted (before the ask)
    const toolResultChunks = chunks.filter(
      (chunk) => (chunk as { type?: string }).type === "tool_result",
    );
    expect(toolResultChunks).toHaveLength(1);

    // The read before the write should have completed
    const allToolCalls = agentRuntimeStore.listToolCalls(session.id);
    expect(allToolCalls).toHaveLength(3);
    const read1 = allToolCalls.find(
      (call) => call.modelToolCallId === "call-read-1",
    );
    expect(read1?.status).toBe("completed");
    const writeCall = allToolCalls.find(
      (call) => call.modelToolCallId === "call-write",
    );
    expect(writeCall?.status).toBe("pending");

    // Run should be waiting_permission
    const [run] = agentLoopRuntime.listRuns(session.id);
    expect(run.status).toBe("waiting_permission");
  });

  it("executes multiple subagent.delegate calls in parallel", async () => {
    queueMockStep(
      makeStream([
        {
          type: "tool-call",
          toolCallId: "call-sub-1",
          toolName: "subagent_delegate",
          input: { profileId: "explorer", prompt: "Check module A." },
        },
        {
          type: "tool-call",
          toolCallId: "call-sub-2",
          toolName: "subagent_delegate",
          input: { profileId: "explorer", prompt: "Check module B." },
        },
        { type: "finish-step", finishReason: "tool-calls", usage: {} },
        { type: "finish", finishReason: "tool-calls", totalUsage: {} },
      ]),
    );
    queueMockStep(makeTextStep("Child A done."));
    queueMockStep(makeTextStep("Child B done."));
    queueMockStep(makeTextStep("Parent done after both children."));

    const session = agentSessionRuntime.create(executorInput);
    agentRuntimeStore.updateSession(session.id, {
      permissionRules: [
        ...session.permissionRules,
        {
          gate: "task",
          pattern: "*",
          action: "allow",
          reason: "Test allows delegation.",
        },
      ],
    });
    await collectChunks(
      agentLoopRuntime.streamRun(session.id, {
        message: "Delegate two checks.",
      }),
    );

    const childSessions = agentRuntimeStore
      .listSessions({ projectId: executorInput.projectId })
      .filter((candidate) => candidate.parentSessionId === session.id);
    expect(childSessions).toHaveLength(2);
    expect(childSessions.every((child) => child.status === "completed")).toBe(
      true,
    );

    const taskCalls = agentRuntimeStore
      .listToolCalls(session.id)
      .filter((call) => call.toolId === "subagent.delegate");
    expect(taskCalls).toHaveLength(2);
    expect(taskCalls.every((call) => call.status === "completed")).toBe(true);
  });

  it("handles a denied tool in parallel without blocking other tools", async () => {
    const readPath = "tmp/agent-loop-runtime-read.txt";
    fs.mkdirSync(path.dirname(path.resolve(readPath)), { recursive: true });
    fs.writeFileSync(path.resolve(readPath), "denied test", "utf8");

    // Set up a deny rule for writes
    const session = agentSessionRuntime.create(executorInput);
    agentRuntimeStore.updateSession(session.id, {
      permissionRules: [
        ...session.permissionRules,
        {
          gate: "write",
          pattern: "*",
          action: "deny",
          reason: "Test denies writes.",
        },
      ],
    });

    queueMockStep(
      makeStream([
        {
          type: "tool-call",
          toolCallId: "call-read",
          toolName: "file_read",
          input: { path: readPath },
        },
        {
          type: "tool-call",
          toolCallId: "call-write",
          toolName: "file_write",
          input: { path: "tmp/denied.txt", content: "denied" },
        },
        { type: "finish-step", finishReason: "tool-calls", usage: {} },
        { type: "finish", finishReason: "tool-calls", totalUsage: {} },
      ]),
    );
    queueMockStep(makeTextStep("Read succeeded, write was denied."));

    const chunks = await collectChunks(
      agentLoopRuntime.streamRun(session.id, { message: "Read and write." }),
    );

    const toolCallChunks = chunks.filter(
      (chunk) => (chunk as { type?: string }).type === "tool_call",
    );
    const toolResultChunks = chunks.filter(
      (chunk) => (chunk as { type?: string }).type === "tool_result",
    );
    expect(toolCallChunks).toHaveLength(2);
    expect(toolResultChunks).toHaveLength(2);

    const allToolCalls = agentRuntimeStore.listToolCalls(session.id);
    const readCall = allToolCalls.find(
      (call) => call.modelToolCallId === "call-read",
    );
    const writeCall = allToolCalls.find(
      (call) => call.modelToolCallId === "call-write",
    );
    expect(readCall?.status).toBe("completed");
    expect(writeCall?.status).toBe("denied");

    // Run should complete (not blocked — denied is not the same as permission ask)
    const [run] = agentLoopRuntime.listRuns(session.id);
    expect(run.status).toBe("completed");
  });

  it("emits tool results in model-dictated order regardless of execution completion order", async () => {
    const readPath = "tmp/agent-loop-runtime-read.txt";
    fs.mkdirSync(path.dirname(path.resolve(readPath)), { recursive: true });
    fs.writeFileSync(path.resolve(readPath), "order test", "utf8");

    queueMockStep(
      makeStream([
        {
          type: "tool-call",
          toolCallId: "call-a",
          toolName: "file_read",
          input: { path: readPath },
        },
        {
          type: "tool-call",
          toolCallId: "call-b",
          toolName: "file_list",
          input: { path: "tmp" },
        },
        {
          type: "tool-call",
          toolCallId: "call-c",
          toolName: "file_glob",
          input: { pattern: "*.txt" },
        },
        { type: "finish-step", finishReason: "tool-calls", usage: {} },
        { type: "finish", finishReason: "tool-calls", totalUsage: {} },
      ]),
    );
    queueMockStep(makeTextStep("All three tools done."));

    const session = agentSessionRuntime.create(executorInput);
    await collectChunks(
      agentLoopRuntime.streamRun(session.id, {
        message: "Three tools in order.",
      }),
    );

    const [run] = agentLoopRuntime.listRuns(session.id);
    const steps = agentLoopRuntime.listRunSteps(session.id, run.id);
    const firstStepParts = agentRuntimeStore.listRunParts(steps[0].id);

    // Verify tool_call parts appear in A, B, C order
    const toolCallParts = firstStepParts.filter(
      (part) => part.kind === "tool_call",
    );
    expect(toolCallParts).toHaveLength(3);

    // Verify tool_result parts appear in A, B, C order (not execution order)
    const toolResultParts = firstStepParts.filter(
      (part) => part.kind === "tool_result",
    );
    expect(toolResultParts).toHaveLength(3);

    // Tool calls and results should be interleaved: call-A, call-B, call-C, result-A, result-B, result-C
    // (this is the new behavior — all tool_calls first, then all tool_results)
    const partKinds = firstStepParts.map((part) => part.kind);
    const toolCallIndices = toolCallParts.map((_, i) =>
      partKinds.indexOf(
        "tool_call",
        i === 0 ? 0 : partKinds.indexOf("tool_call", 0) + i,
      ),
    );
    const toolResultIndices = toolResultParts.map((_, i) =>
      partKinds.indexOf(
        "tool_result",
        i === 0 ? 0 : partKinds.indexOf("tool_result", 0) + i,
      ),
    );

    // All tool_calls come before all tool_results
    const maxCallIndex = Math.max(...toolCallIndices.filter((idx) => idx >= 0));
    const minResultIndex = Math.min(
      ...toolResultIndices.filter((idx) => idx >= 0),
    );
    expect(maxCallIndex).toBeLessThan(minResultIndex);
  });

  it("rejects concurrent streamRun with SESSION_BUSY", async () => {
    const session = agentSessionRuntime.create(executorInput);
    const runtime = agentLoopRuntime as unknown as {
      activeSessionControllers: Map<string, Set<AbortController>>;
    };
    runtime.activeSessionControllers.set(
      session.id,
      new Set([new AbortController()]),
    );

    try {
      await expect(
        collectChunks(
          agentLoopRuntime.streamRun(session.id, {
            message: "Second run should be rejected.",
          }),
        ),
      ).rejects.toMatchObject({ code: "SESSION_BUSY", status: 409 });
    } finally {
      runtime.activeSessionControllers.delete(session.id);
    }
  });

  it("continues with a new message after user stop", async () => {
    const session = agentSessionRuntime.create(executorInput);
    agentSessionRuntime.cancel(session.id);

    queueMockStep(makeTextStep("Continued after stop."));
    const chunks = await collectChunks(
      agentLoopRuntime.streamContinue(session.id, {
        message: "Please continue.",
      }),
    );

    expect(chunks.some((chunk) => chunk.type === "run_started")).toBe(true);
    expect(chunks.some((chunk) => chunk.type === "message")).toBe(true);
    expect(agentRuntimeStore.getSession(session.id).status).toBe("completed");
  });

  it.each([false, true])(
    "only injects explicitly forced input between steps (forced: %s)",
    async (forced) => {
      const readPath = "tmp/agent-loop-runtime-read.txt";
      fs.mkdirSync(path.dirname(path.resolve(readPath)), { recursive: true });
      fs.writeFileSync(path.resolve(readPath), "queued inject file", "utf8");

      const session = agentSessionRuntime.create(executorInput);
      const items = inputQueueService.enqueue(session.id, {
        message: "Please summarize after reading.",
      });

      queueMockStep(
        makeToolStep({
          message: "Reading file first.",
          toolName: "file_read",
          toolCallId: "call-read",
          args: { path: readPath },
        }),
      );
      queueMockStep(makeTextStep("Summary after queued input."));

      const chunks: AgentRunStreamChunk[] = [];
      for await (const chunk of agentLoopRuntime.streamRun(session.id, {
        message: "Start by reading the file.",
      })) {
        chunks.push(chunk);
        if (forced && chunk.type === "tool_result")
          inputQueueService.markForceInject(session.id, items[0].id);
      }

      expect(chunks.some((chunk) => chunk.type === "input_injected")).toBe(
        forced,
      );
      expect(inputQueueService.list(session.id)).toHaveLength(forced ? 0 : 1);
      expect(agentRuntimeStore.getSession(session.id).status).toBe("completed");
      const userMessages = agentRuntimeStore
        .listMessages(session.id)
        .filter((m) => m.role === "user");
      expect(
        userMessages.some((m) =>
          m.content.includes("Please summarize after reading."),
        ),
      ).toBe(forced);
    },
  );
  it("suspends for a form, resumes, then offers a one-time execute-or-cancel plan choice", async () => {
    ensureSynaxAgentRegistered();
    const questions = [
      { id: "scope", type: "text", label: "Scope?", required: true },
    ];
    const plan = {
      title: "Small plan",
      objective: "Implement a bounded change",
      steps: [
        {
          id: "s1",
          title: "Implement",
          description: "Do the approved work",
          dependsOn: [],
          expectedFiles: [],
        },
      ],
      acceptanceCriteria: ["The behavior is verified"],
      assumptions: [],
      risks: [],
    };
    queueMockStep(
      makeToolStep({
        toolName: "human_ask",
        toolCallId: "ask-1",
        args: { title: "Clarify scope", questions },
      }),
    );
    queueMockStep(
      makeToolStep({
        toolName: "plan_propose",
        toolCallId: "plan-1",
        args: plan,
      }),
    );
    const session = agentSessionRuntime.create({
      projectId: "project-alpha",
      profileId: "synax",
      prompt: "Plan a bounded implementation",
      sessionMetadata: { mode: "plan" },
    });
    await collectChunks(agentLoopRuntime.streamRun(session.id, {}));
    const [run] = agentLoopRuntime.listRuns(session.id);
    expect(run.status).toBe("waiting_input");
    const first = interactionService.pending(session.id)!;
    expect(first.kind).toBe("clarification");
    interactionService.reply(session.id, first.id, {
      revision: first.revision,
      action: "submit",
      answers: { scope: "Only the API" },
    });
    await agentLoopRuntime.resumeRun(session.id);
    expect(agentLoopRuntime.listRuns(session.id)).toHaveLength(1);
    expect(
      agentRuntimeStore.getToolCall(session.id, first.toolCallId).outputRef,
    ).toMatchObject({ answers: { scope: "Only the API" } });
    const parts = agentRuntimeStore.listRunParts(first.stepId);
    expect(
      parts.filter(
        (p) => p.kind === "tool_result" && p.toolCallId === first.toolCallId,
      ),
    ).toHaveLength(1);
    const approval = interactionService.pending(session.id)!;
    expect(approval.kind).toBe("plan_approval");
    expect(
      agentRuntimeStore.listToolCalls(session.id).map((c) => c.toolId),
    ).toEqual(["human.ask", "plan.propose"]);
    interactionService.reply(session.id, approval.id, {
      revision: approval.revision,
      action: "cancel",
    });
    await agentLoopRuntime.resumeRun(session.id);
    expect(interactionService.pending(session.id)).toBeNull();
    expect(agentRuntimeStore.getSession(session.id)).toMatchObject({
      status: "completed",
      sessionMetadata: { mode: "plan", plan: { status: "saved", revision: 1 } },
    });
  });

  it("rejects an entire mixed interaction batch before a write can execute", async () => {
    ensureSynaxAgentRegistered();
    queueMockStep(
      makeStream([
        {
          type: "tool-call",
          toolCallId: "ask",
          toolName: "human_ask",
          input: {
            title: "Clarify",
            questions: [{ id: "ok", type: "boolean", label: "Proceed?" }],
          },
        },
        {
          type: "tool-call",
          toolCallId: "write",
          toolName: "file_write",
          input: {
            path: "tmp/agent-loop-runtime-write.txt",
            content: "must not execute",
          },
        },
        { type: "finish-step", finishReason: "tool-calls", usage: {} },
      ]),
    );
    queueMockStep(makeTextStep("I will ask separately."));
    const session = agentSessionRuntime.create({
      projectId: "project-alpha",
      profileId: "synax",
      prompt: "Inspect this",
      permissionTier: "unrestricted",
      sessionMetadata: { mode: "chat" },
    });
    await collectChunks(agentLoopRuntime.streamRun(session.id, {}));
    expect(
      fs.existsSync(path.resolve("tmp/agent-loop-runtime-write.txt")),
    ).toBe(false);
    expect(interactionService.pending(session.id)).toBeNull();
    expect(agentRuntimeStore.listToolCalls(session.id)).toHaveLength(2);
    expect(
      agentRuntimeStore
        .listToolCalls(session.id)
        .every((c) => c.toolId === "tools.invalid"),
    ).toBe(true);
    expect(agentRuntimeStore.getSession(session.id).status).toBe("completed");
  });

  it("converts a legacy pending plan approval into a saved plan when a later user turn arrives", async () => {
    ensureSynaxAgentRegistered();
    const plan = {
      title: "Legacy plan",
      objective: "Save the pending plan",
      steps: [
        { id: "s1", title: "Implement", description: "Apply the change" },
      ],
      acceptanceCriteria: ["The change is verified"],
    };
    const session = agentSessionRuntime.create({
      projectId: "project-alpha",
      profileId: "synax",
      prompt: "Plan this change",
      sessionMetadata: { mode: "plan" },
    });
    const now = new Date().toISOString();
    const run = agentRuntimeStore.appendRun({
      id: "legacy-plan-run",
      sessionId: session.id,
      status: "running",
      startedAt: now,
      completedAt: null,
      triggerMessageId: null,
      currentStep: 1,
      stopReason: null,
      model: null,
      metadata: {},
    });
    const step = agentRuntimeStore.appendRunStep({
      id: "legacy-plan-step",
      runId: run.id,
      sessionId: session.id,
      index: 1,
      status: "running",
      model: null,
      startedAt: now,
      completedAt: null,
      finishReason: null,
      metadata: {},
    });
    agentRuntimeStore.updateSession(session.id, { activeRunId: run.id });
    const call = agentRuntimeStore.appendToolCall({
      id: "legacy-plan-call",
      sessionId: session.id,
      runId: run.id,
      stepId: step.id,
      modelToolCallId: "legacy-plan-call",
      toolId: "plan.propose",
      category: "task",
      mutability: "task",
      argsHash: "legacy",
      inputSummary: "",
      inputRef: plan,
      outputSummary: null,
      outputRef: null,
      status: "running",
      permissionDecisionId: null,
      startedAt: now,
      endedAt: null,
      error: null,
    });
    interactionService.request({
      sessionId: session.id,
      runId: run.id,
      stepId: step.id,
      toolCallId: call.id,
      kind: "plan_approval",
      request: { plan },
    });

    queueMockStep(makeTextStep("Plan saved for later execution."));
    await collectChunks(
      agentLoopRuntime.streamRun(session.id, { message: "执行这个计划。" }),
    );

    expect(interactionService.pending(session.id)).toBeNull();
    expect(agentRuntimeStore.getSession(session.id)).toMatchObject({
      status: "completed",
      sessionMetadata: { mode: "plan", plan: { status: "saved", revision: 1 } },
    });
    expect(
      agentLoopRuntime.listRuns(session.id).find((item) => item.id === run.id),
    ).toMatchObject({ status: "completed", stopReason: "plan_saved" });
    expect(
      agentLoopRuntime.listRuns(session.id).some((item) => item.id !== run.id),
    ).toBe(true);
    expect(
      agentRuntimeStore
        .listMessages(session.id)
        .some((message) => message.content === "执行这个计划。"),
    ).toBe(true);
  });

  it("yields the round at the soft step threshold without accepting the goal", async () => {
    ensureSynaxAgentRegistered();
    queueMockStep(makeTextStep("Everything is done."));
    queueMockStep(makeTextStep("Everything is done again."));
    const session = agentSessionRuntime.create({
      projectId: "project-alpha",
      profileId: "synax",
      prompt: "Complete an approved goal",
      sessionMetadata: { mode: "goal" },
    });
    await collectChunks(
      agentLoopRuntime.streamRun(session.id, { maxSteps: 2 }),
    );
    expect(agentRuntimeStore.getSession(session.id)).toMatchObject({
      status: "completed",
      sessionMetadata: { goal: { status: "planning" } },
    });
    expect(agentLoopRuntime.listRuns(session.id)[0]).toMatchObject({
      status: "completed",
      stopReason: "round_yielded",
    });
    expect(workStore.current(session.id)).toMatchObject({
      status: "active",
      result: null,
    });
    expect(
      agentLoopRuntime.listRuns(session.id)[0].metadata.roundHandoff,
    ).toMatchObject({ summary: "Everything is done again." });
    expect(
      agentRuntimeStore
        .listMessages(session.id)
        .some((message) => message.metadata.purpose === "round_handoff"),
    ).toBe(true);
  });

  it("executes a plan immediately from the one-time approval HITL", async () => {
    ensureSynaxAgentRegistered();
    const plan = {
      title: "Immediate plan",
      objective: "Execute from the shortcut",
      steps: [{ id: "s1", title: "Execute", description: "Run immediately" }],
      acceptanceCriteria: ["Execution starts"],
    };
    queueMockStep(
      makeToolStep({
        toolName: "plan_propose",
        toolCallId: "immediate-plan",
        args: plan,
      }),
    );
    const session = agentSessionRuntime.create({
      projectId: "project-alpha",
      profileId: "synax",
      prompt: "Plan and execute",
      sessionMetadata: { mode: "plan" },
    });
    await collectChunks(agentLoopRuntime.streamRun(session.id, {}));
    const approval = interactionService.pending(session.id)!;
    expect(approval.kind).toBe("plan_approval");
    interactionService.reply(session.id, approval.id, {
      revision: approval.revision,
      action: "execute",
    });
    queueMockStep(
      makeToolStep({
        toolName: "human_ask",
        toolCallId: "blocked-chat",
        args: {
          title: "Blocked: execution needs input",
          questions: [
            {
              id: "unblock",
              type: "text",
              label: "Provide the missing execution detail",
            },
          ],
        },
      }),
    );
    await agentLoopRuntime.resumeRun(session.id);
    // A declared blocker no longer dead-ends the session: it parks on an
    // interaction checkpoint (waiting_input) without creating a goal,
    // so answering the interaction resumes the same run.
    expect(agentRuntimeStore.getSession(session.id)).toMatchObject({
      status: "waiting_input",
      sessionMetadata: {
        mode: "chat",
        goal: null,
        plan: { status: "approved", revision: 1 },
      },
    });
    const blocker = interactionService.pending(session.id)!;
    expect(blocker.kind).toBe("clarification");
    expect(blocker.request.title).toContain("Blocked:");
    expect(
      agentRuntimeStore.listToolCalls(session.id).map((c) => c.toolId),
    ).toEqual(["plan.propose", "human.ask"]);
  });

  it("executes a deferred plan from a later user instruction and finishes in chat without a goal acceptance loop", async () => {
    ensureSynaxAgentRegistered();
    const criterion = "Package metadata was inspected";
    const plan = {
      title: "Inspect package",
      objective: criterion,
      steps: [
        {
          id: "read",
          title: "Read package",
          description: "Inspect package.json",
        },
      ],
      acceptanceCriteria: [criterion],
    };
    queueMockStep(
      makeToolStep({
        toolName: "plan_propose",
        toolCallId: "propose-goal",
        args: plan,
      }),
    );
    const session = agentSessionRuntime.create({
      projectId: "project-alpha",
      profileId: "synax",
      prompt: "Plan package inspection",
      sessionMetadata: { mode: "plan" },
    });
    await collectChunks(agentLoopRuntime.streamRun(session.id, {}));
    expect(interactionService.pending(session.id)?.kind).toBe("plan_approval");
    expect(agentRuntimeStore.getSession(session.id)).toMatchObject({
      status: "waiting_input",
      sessionMetadata: { mode: "plan", plan: { status: "draft" } },
    });

    queueMockStep(
      makeToolStep({
        toolName: "plan_execute",
        toolCallId: "execute-plan",
        args: { reason: "User explicitly requested execution." },
      }),
    );
    queueMockStep(
      makeToolStep({
        toolName: "file_read",
        toolCallId: "proof-read",
        args: { path: "package.json" },
      }),
    );
    queueMockStep(
      makeToolStep({
        toolName: "task_update",
        toolCallId: "task-done",
        args: { taskId: "1", status: "completed" },
      }),
    );
    queueMockStep(makeTextStep("Package metadata verified."));
    await collectChunks(
      agentLoopRuntime.streamRun(session.id, {
        message: "执行这个计划，完成验收后结束。",
      }),
    );
    expect(agentRuntimeStore.getSession(session.id)).toMatchObject({
      status: "completed",
      sessionMetadata: {
        mode: "chat",
        goal: null,
        plan: { status: "approved", revision: 1 },
      },
    });
    expect(agentLoopRuntime.listRuns(session.id)).toHaveLength(2);
    expect(
      agentRuntimeStore
        .listToolCalls(session.id)
        .every((c) => c.status === "completed"),
    ).toBe(true);
    expect(mockStepResults).toHaveLength(0);
  });

  it("lets the agent switch modes on an explicit user instruction", async () => {
    ensureSynaxAgentRegistered();
    const plan = {
      title: "Switch plan",
      objective: "Prepare a plan from chat",
      steps: [{ id: "plan", title: "Plan", description: "Prepare the plan" }],
      acceptanceCriteria: ["A plan is saved"],
    };
    queueMockStep(
      makeToolStep({
        toolName: "mode_switch",
        toolCallId: "switch-plan",
        args: { mode: "plan", reason: "The user asked to plan first." },
      }),
    );
    queueMockStep(
      makeToolStep({
        toolName: "plan_propose",
        toolCallId: "save-plan",
        args: plan,
      }),
    );
    const session = agentSessionRuntime.create({
      projectId: "project-alpha",
      profileId: "synax",
      prompt: "Prepare this work",
      sessionMetadata: { mode: "chat" },
    });
    await collectChunks(
      agentLoopRuntime.streamRun(session.id, {
        message: "先切到计划模式，帮我规划一下。",
      }),
    );
    expect(agentRuntimeStore.getSession(session.id)).toMatchObject({
      status: "waiting_input",
      sessionMetadata: { mode: "plan", plan: { status: "draft" } },
    });
    expect(interactionService.pending(session.id)?.kind).toBe("plan_approval");
    expect(
      agentRuntimeStore.listToolCalls(session.id).map((c) => c.toolId),
    ).toEqual(["mode.switch", "plan.propose"]);
  });

  it("runs a task-defined specialist with its persisted effective capability profile", async () => {
    ensureSynaxAgentRegistered();
    queueMockStep(
      makeToolStep({
        toolName: "subagent_delegate",
        toolCallId: "specialist-1",
        args: {
          specialist: {
            name: "Package expert",
            role: "Node package reviewer",
            instructions: "Inspect package metadata only",
            capabilities: ["file.read"],
            skillIds: [],
          },
          prompt: "Read package.json",
          deliverable: "Name and scripts",
        },
      }),
    );
    queueMockStep(
      makeToolStep({
        toolName: "file_read",
        toolCallId: "expert-read",
        args: { path: "package.json" },
      }),
    );
    queueMockStep(makeTextStep("Package metadata reviewed."));
    queueMockStep(makeTextStep("Expert review integrated."));
    const session = agentSessionRuntime.create({
      projectId: "project-alpha",
      profileId: "synax",
      prompt: "Inspect package metadata",
      sessionMetadata: { mode: "chat" },
    });
    await collectChunks(agentLoopRuntime.streamRun(session.id, {}));
    const [child] = agentRuntimeStore
      .listSessionTree(session.id)
      .filter((s) => s.parentSessionId === session.id);
    expect(child).toMatchObject({
      profileId: "specialist",
      status: "completed",
      sessionMetadata: {
        specialist: { name: "Package expert", capabilities: ["file.read"] },
      },
    });
    expect(
      agentRuntimeStore.listToolCalls(child.id).map((c) => c.toolId),
    ).toEqual(["file.read"]);
    expect(agentRuntimeStore.getSession(session.id).status).toBe("completed");
    expect(mockStepResults).toHaveLength(0);
  });
});

describe("cooperative closing incident replay", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStepResults.length = 0;
    resetAgentRuntimeFixtures();
  });

  it("delivers a small verified edit without another final-check loop", async () => {
    const file = "tmp/work-closing-fixture.cjs";
    fs.mkdirSync(path.resolve("tmp"), { recursive: true });
    fs.writeFileSync(path.resolve(file), "module.exports = false;");
    try {
      queueMockStep(
        makeToolStep({
          toolName: "file_read",
          toolCallId: "read",
          args: { path: file },
        }),
      );
      queueMockStep(
        makeToolStep({
          toolName: "file_write",
          toolCallId: "write",
          args: { path: file, content: "module.exports = true;" },
        }),
      );
      queueMockStep(
        makeToolStep({
          toolName: "bash",
          toolCallId: "verify",
          args: {
            command: `node -e "if(require('./${file}')!==true)process.exit(1)"`,
            criterion: "Requested behavior",
            purpose: "Focused behavior check",
            scope: [file],
          },
        }),
      );
      queueMockStep(
        makeTextStep("Implemented and verified the requested behavior."),
      );
      queueMockStep(
        makeToolStep({
          toolName: "bash",
          toolCallId: "unnecessary",
          args: { command: "git status --porcelain" },
        }),
      );
      const session = agentSessionRuntime.create({
        ...executorInput,
        permissionTier: "unrestricted",
      });
      await collectChunks(
        agentLoopRuntime.streamRun(session.id, {
          message: "Make the small change and verify it.",
        }),
      );
      expect(agentRuntimeStore.getSession(session.id).status).toBe("completed");
      expect(
        agentRuntimeStore.listToolCalls(session.id).map((c) => c.toolId),
      ).toEqual(["file.read", "file.write", "bash"]);
      expect(mockStepResults).toHaveLength(1);
      expect(agentRuntimeStore.listRuns(session.id)[0].currentStep).toBe(4);
    } finally {
      fs.rmSync(path.resolve(file), { force: true });
    }
  });

  it("does not reopen completed work on a continue request", async () => {
    queueMockStep(makeTextStep("The investigation is complete."));
    const session = agentSessionRuntime.create(executorInput);
    await collectChunks(
      agentLoopRuntime.streamRun(session.id, {
        message: "Explain the existing result.",
      }),
    );
    const count = agentRuntimeStore.listSessionSteps(session.id).length;
    await collectChunks(
      agentLoopRuntime.streamRun(session.id, { message: "继续" }),
    );
    expect(agentRuntimeStore.getSession(session.id).status).toBe("completed");
    expect(agentRuntimeStore.listSessionSteps(session.id)).toHaveLength(count);
    expect(
      agentRuntimeStore
        .listMessages(session.id)
        .filter((m) => m.metadata.purpose === "work_result"),
    ).toHaveLength(1);
  });
});

describe("chat turn boundaries", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStepResults.length = 0;
    capturedRequests.length = 0;
    resetAgentRuntimeFixtures();
    ensureSynaxAgentRegistered();
  });

  it("ends with an honest partial summary after a failed check, without accepting pending TODOs or resuming an old goal", async () => {
    const session = agentSessionRuntime.create({
      ...executorInput,
      profileId: "synax",
      permissionTier: "unrestricted",
      sessionMetadata: { mode: "chat" },
    });
    agentRuntimeStore.updateSessionMetadata(session.id, {
      goal: {
        objective: "Historical goal",
        status: "blocked",
        reason: "Historical blocker",
      },
    });
    queueMockStep(
      makeToolStep({
        toolName: "task_create",
        toolCallId: "pending",
        args: {
          subject: "Remaining implementation",
          description: "Not yet done",
        },
      }),
    );
    queueMockStep(
      makeToolStep({
        toolName: "bash",
        toolCallId: "failed-check",
        args: { command: 'node -e "process.exit(1)"' },
      }),
    );
    queueMockStep(
      makeTextStep(
        "Partial result. The check failed; implementation remains incomplete.",
      ),
    );
    const chunks = await collectChunks(
      agentLoopRuntime.streamRun(session.id, {
        message: "Investigate and report the result.",
      }),
    );
    expect(chunks.some((c) => c.type === "run_completed")).toBe(true);
    expect(agentRuntimeStore.getSession(session.id)).toMatchObject({
      status: "completed",
      resultSummary:
        "Partial result. The check failed; implementation remains incomplete.",
      sessionMetadata: { mode: "chat", goal: { status: "blocked" } },
    });
    expect(workStore.current(session.id)?.status).toBe("active");
    expect(
      agentRuntimeStore.listToolCalls(session.id).map((c) => c.toolId),
    ).toEqual(["task.create", "bash"]);
    expect(
      goalContinuationInput(
        session.id,
        agentRuntimeStore.listRuns(session.id)[0].id,
      ),
    ).toBeNull();
    for (const request of capturedRequests) {
      expect(request.tools).not.toEqual(
        expect.arrayContaining(["work_checkpoint"]),
      );
      expect(request.tools).not.toContain("goal_finish");
      expect(request.tools).not.toContain("verification_run");
    }
    expect(mockStepResults).toHaveLength(0);
  });
});

describe("advisory closing state", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStepResults.length = 0;
    resetAgentRuntimeFixtures();
  });
  it("allows a remaining read-only check after TODO completion and accepts an explicit closing decision", async () => {
    queueMockStep(
      makeToolStep({
        toolName: "task_create",
        toolCallId: "todo",
        args: {
          subject: "Inspect the known behavior",
          description: "Read-only assessment",
        },
      }),
    );
    queueMockStep(
      makeToolStep({
        toolName: "task_update",
        toolCallId: "done",
        args: { taskId: "1", status: "completed" },
      }),
    );
    queueMockStep(
      makeToolStep({
        toolName: "bash",
        toolCallId: "extra-check",
        args: {
          command: "node -p '1 + 1'",
        },
      }),
    );
    queueMockStep(makeTextStep("Inspection complete."));
    const session = agentSessionRuntime.create({
      ...executorInput,
      permissionTier: "unrestricted",
    });
    await collectChunks(
      agentLoopRuntime.streamRun(session.id, {
        message: "Report the known behavior without changing files.",
      }),
    );
    const extra = agentRuntimeStore
      .listToolCalls(session.id)
      .find((c) => c.modelToolCallId === "extra-check");
    expect(extra?.status).toBe("completed");
    expect(extra?.outputRef).toMatchObject({ stdout: "2\n", exitCode: 0 });
    expect(workStore.current(session.id)).toMatchObject({
      status: "completed",
      result: "Inspection complete.",
    });
    expect(agentRuntimeStore.getSession(session.id).status).toBe("completed");
    expect(mockStepResults).toHaveLength(0);
  });
});

describe("provider-bound session initialization prompt", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    capturedRequests.length = 0;
    mockStepResults.length = 0;
    resetAgentRuntimeFixtures();
    ensureSynaxAgentRegistered();
  });

  it("mounts selected skills through skill.load, quotes file evidence, and counts skill output", async () => {
    const dir = fs.mkdtempSync(
      path.join(os.tmpdir(), "synax-prompt-references-"),
    );
    const marker = "SELECTED_SKILL_BODY";
    fs.writeFileSync(
      path.join(dir, "reference.txt"),
      "</reference-context>FILE_EVIDENCE",
    );
    const skill = {
      id: "fixture/skill",
      name: "skill",
      label: "Fixture skill",
      description: "Inspect the selected file",
      status: "available" as const,
      sourceId: "fixture",
      sourceKind: "local" as const,
      version: "1",
      appliesTo: [],
      requiredCapabilities: [],
      permissionHints: [],
      installPath: path.join(dir, "SKILL.md"),
    };
    fs.writeFileSync(skill.installPath, marker);
    const spies = [
      vi.spyOn(skillRegistry, "listSummaries").mockReturnValue([skill]),
      vi.spyOn(skillRegistry, "getSummary").mockReturnValue(skill),
      vi
        .spyOn(skillRegistry, "loadDetail")
        .mockReturnValue({ ...skill, content: marker }),
    ];
    try {
      const session = agentSessionRuntime.create({
        projectId: "prompt-fixture",
        profileId: "synax",
        prompt: "Read the selected file",
        permissionTier: "unrestricted",
        workDir: dir,
      });
      queueMockStep(makeTextStep("Read the reference."));
      await collectChunks(
        agentLoopRuntime.streamRun(session.id, {
          message: "Read the selected file",
          references: [
            { kind: "skill", id: skill.id },
            { kind: "skill", id: skill.id },
            { kind: "file", id: "reference.txt" },
          ],
        }),
      );
      expect(capturedRequests).toHaveLength(1);
      const system = String(capturedRequests[0].messages[0].content);
      expect(system).not.toContain(marker);
      expect(system).not.toContain('"instructionsIncluded":true');
      expect(system).toContain('"selectedForTurnMount":true');
      expect(system).toContain("\\u003c/reference-context>FILE_EVIDENCE");
      expect(system).toContain(
        "User-selected file and Wiki references for this turn",
      );
      const serializedMessages = JSON.stringify(capturedRequests[0].messages);
      expect(serializedMessages).toContain(marker);
      expect(serializedMessages).toContain('"tool-call"');
      expect(serializedMessages).toContain('"tool-result"');
      expect(spies[2]).toHaveBeenCalledTimes(1);
      const skillCalls = agentRuntimeStore
        .listToolCalls(session.id)
        .filter((call) => call.toolId === "skill.load");
      expect(skillCalls).toHaveLength(1);
      expect(skillCalls[0]?.inputRef).toEqual({ skillId: skill.id });
      const composition = agentRuntimeStore
        .listSessionSteps(session.id)
        .map((step) => step.metadata.contextComposition)
        .find(Boolean) as { skills: number; usage?: { skills: number } };
      expect(composition.skills).toBeGreaterThan(0);
      expect(composition.usage?.skills).toBeGreaterThan(0);
      const reminder = String(capturedRequests[0].messages.at(-1)!.content);
      const environmentLine = reminder
        .split("\n")
        .find((line) => line.startsWith('{"cwd":'))!;
      expect(JSON.parse(environmentLine)).toMatchObject({
        cwd: fs.realpathSync(dir),
        workspaceRoots: resolveSessionWorkspaceRoots(
          session.id,
          "prompt-fixture",
        ),
      });
      expect(system).not.toContain("## Runtime environment");
    } finally {
      spies.forEach((spy) => spy.mockRestore());
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each([300_000, 500_000, 500_001])(
    "preserves tool clearing and dedup at %i input tokens in a 1M window",
    async (inputTokens) => {
      const shouldClear = inputTokens > 500_000;
      vi.mocked(resolveGatewaySelection).mockResolvedValueOnce({
        modelDef: { reasoning: true, contextLimit: 1_000_000 },
        providerId: "fixture",
      } as never);
      const directory = fs.mkdtempSync(
        path.join(os.tmpdir(), "synax-tool-clearing-"),
      );
      try {
        for (let n = 0; n < 4; n++)
          fs.writeFileSync(
            path.join(directory, `${n}.txt`),
            `CLEARING_EVIDENCE_${n}`,
          );
        const session = agentSessionRuntime.create({
          projectId: "clearing-fixture",
          workDir: directory,
          profileId: "synax",
          prompt: "Read and then recheck the evidence",
          permissionTier: "unrestricted",
        });
        queueMockStep(
          makeStream([
            ...Array.from({ length: 4 }, (_, n) => ({
              type: "tool-call" as const,
              toolCallId: `read-${n}`,
              toolName: "file_read",
              input: { path: `${n}.txt` },
            })),
            {
              type: "finish-step",
              finishReason: "tool-calls",
              usage: { inputTokens },
            },
          ]),
        );
        queueMockStep(
          makeToolStep({
            toolName: "file_read",
            toolCallId: "reread-0",
            args: { path: "0.txt" },
          }),
        );
        queueMockStep(makeTextStep("Evidence checked."));
        await collectChunks(
          agentLoopRuntime.streamRun(session.id, {
            message: "Read and then recheck the evidence",
          }),
        );
        expect(capturedRequests).toHaveLength(3);
        const results = capturedRequests[1].messages
          .filter((m) => m.role === "tool")
          .flatMap(
            (m) => m.content as Array<{ toolCallId: string; output: unknown }>,
          );
        // Calls execute concurrently; check by actual persisted order rather than assuming completion order.
        const calls = agentRuntimeStore.listToolCalls(session.id);
        const initialCalls = calls.filter((c) =>
          c.modelToolCallId?.startsWith("read-"),
        );
        const cleared = results.find(
          (r) => r.toolCallId === initialCalls[0].modelToolCallId,
        )!;
        expect(JSON.stringify(cleared.output).includes("result cleared")).toBe(
          shouldClear,
        );
        for (const call of initialCalls.slice(1)) {
          expect(
            JSON.stringify(
              results.find((r) => r.toolCallId === call.modelToolCallId)
                ?.output,
            ),
          ).not.toContain("result cleared");
        }
        expect(workStore.current(session.id)?.checkpoint).toBeFalsy();
        // The first call is inserted before parallel execution and must remain eligible for re-reading.
        expect(initialCalls[0].modelToolCallId).toBe("read-0");
        const reread = calls.find((c) => c.modelToolCallId === "reread-0")!;
        expect(reread.status).toBe(shouldClear ? "completed" : "compacted");
        expect(reread.outputRef === null).toBe(!shouldClear);
        expect(
          JSON.stringify(capturedRequests[2].messages).includes(
            "result cleared",
          ),
        ).toBe(shouldClear);
        expect(
          agentRuntimeStore.listRuns(session.id)[0].metadata.contextLimit,
        ).toBe(1_000_000);
        expect(initialCalls[0].outputRef).not.toBeNull();
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    },
  );

  it("freezes compact first-emission tool receipts without rewriting raw results or later prefixes", async () => {
    const session = agentSessionRuntime.create({
      projectId: "receipt-fixture",
      workDir: process.cwd(),
      profileId: "synax",
      prompt: "Inspect the diagnostic log",
      permissionTier: "unrestricted",
    });
    queueMockStep(
      makeToolStep({
        toolName: "bash",
        toolCallId: "large-log",
        args: {
          command: `node -e "console.log('noise line\\n'.repeat(2200)); console.error('Error: LATE_RECEIPT_PROBE'); process.exitCode=1"`,
        },
      }),
    );
    queueMockStep(
      makeToolStep({
        toolName: "file_read",
        toolCallId: "read-after-log",
        args: { path: "package.json" },
      }),
    );
    queueMockStep(makeTextStep("The stored log contains a late failure."));
    await collectChunks(
      agentLoopRuntime.streamRun(session.id, {
        message: "Inspect the diagnostic log",
      }),
    );
    expect(capturedRequests).toHaveLength(3);
    const call = agentRuntimeStore
      .listToolCalls(session.id)
      .find((record) => record.modelToolCallId === "large-log")!;
    expect(
      (call.outputRef as { stdout: string }).stdout.length,
    ).toBeGreaterThan(12000);
    const step = agentRuntimeStore.getRunStep(call.stepId!);
    const receipt = (
      step.metadata.toolContextReceipts as Record<
        string,
        { text: string; originalChars: number; projectedChars: number }
      >
    )[call.id];
    expect(receipt.text).toContain("LATE_RECEIPT_PROBE");
    expect(receipt.projectedChars).toBeLessThan(receipt.originalChars);
    expect(JSON.stringify(capturedRequests[1].messages)).toContain(
      "Tool context receipt",
    );
    expect(
      capturedRequests[2].messages.slice(
        0,
        capturedRequests[1].messages.length,
      ),
    ).toEqual(capturedRequests[1].messages);
    expect(
      (
        agentRuntimeStore.getRunStep(call.stepId!).metadata
          .toolContextReceipts as Record<string, unknown>
      )[call.id],
    ).toEqual(receipt);
  });

  it.each(["你好", "plan 模式真的有效吗？", "请调查会话列表的过滤机制"])(
    "preserves request intent all the way to the model: %s",
    async (message) => {
      vi.mocked(resolveGatewaySelection).mockResolvedValueOnce({
        modelDef: { reasoning: true, contextLimit: 200000 },
        providerId: "fixture",
      } as never);
      const prompt = buildSessionPrompt({
        mode: "session",
        content: message,
        wikiAttachMode: "auto",
        locale: "zh",
      });
      const session = agentSessionRuntime.create({
        projectId: "prompt-fixture",
        workDir: process.cwd(),
        profileId: "synax",
        prompt,
        reasoningEffort: "max",
        sessionMetadata: {
          source: "session-page",
          mode: "chat",
          goalContent: message,
          wikiAttachMode: "auto",
        },
      });
      queueMockStep(makeTextStep("根据已有信息作答。"));
      await collectChunks(
        agentLoopRuntime.streamRun(session.id, { message: prompt }),
      );
      expect(capturedRequests).toHaveLength(1);
      const request = capturedRequests[0];
      const text = JSON.stringify(request.messages);
      expect(
        request.messages
          .filter((m) => m.role === "user")
          .some((m) => m.content === message),
      ).toBe(true);
      expect(text).not.toContain("implement the goal");
      expect(text).not.toContain("Think and process internally in English");
      expect(text).not.toContain("first and only tool call");
      expect(text).not.toContain("One logical change per step");
      expect(text).not.toContain("otherwise run a code-map scan");
      expect(text).not.toContain("Keep wiki documentation aligned");
      expect(text).toContain("Finish this turn with a concise answer");
      expect(request.reasoningEffort).toBe("max");
      expect(workStore.current(session.id)?.objective).toBe(message);
      expect(agentRuntimeStore.listToolCalls(session.id)).toHaveLength(0);
      if (message !== "你好") expect(text).toContain("Investigate and explain");
    },
  );

  it("repairs legacy initial scaffolding in projection without changing the transcript or re-injecting it on step two", async () => {
    const raw = "请调查 package.json";
    const prompt = buildSessionPrompt({
      mode: "direct",
      content: raw,
      wikiAttachMode: "auto",
    });
    const session = agentSessionRuntime.create({
      projectId: "prompt-fixture",
      workDir: process.cwd(),
      profileId: "synax",
      prompt,
      sessionMetadata: {
        source: "session-page",
        mode: "chat",
        goalContent: raw,
      },
    });
    queueMockStep(
      makeToolStep({
        toolName: "file_read",
        toolCallId: "read",
        args: { path: "package.json" },
      }),
    );
    queueMockStep(makeTextStep("已核对文件。"));
    await collectChunks(
      agentLoopRuntime.streamRun(session.id, {
        message: prompt,
        messageSource: "system_injection",
      }),
    );
    expect(capturedRequests).toHaveLength(2);
    for (const request of capturedRequests) {
      expect(JSON.stringify(request.messages)).not.toContain(
        "implement the goal",
      );
      expect(JSON.stringify(request.messages)).toContain(
        "Investigate and explain",
      );
    }
    expect(
      agentRuntimeStore.listMessages(session.id).find((m) => m.role === "user")
        ?.content,
    ).toBe(prompt);
  });

  it("keeps a newer mode when an accepted run starts after a setting change", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synax-queued-mode-"));
    const outside = path.join(dir, "outside.txt");
    fs.writeFileSync(outside, "not silently readable");
    const session = agentSessionRuntime.create({
      projectId: "prompt-fixture",
      profileId: "synax",
      prompt: "Inspect queued mode",
      workDir: process.cwd(),
      permissionTier: "boundary",
      sessionMetadata: { mode: "chat" },
    });
    const accepted = acceptRuntimeRun(
      session.id,
      { message: "Inspect queued mode", permissionTier: "unrestricted" },
      "queued-policy",
    );
    expect(
      agentRuntimeStore.getSession(session.id).sessionMetadata?.permissionTier,
    ).toBe("unrestricted");
    applySessionPermissionUpdate(session.id, { permissionTier: "boundary" });
    queueMockStep(
      makeToolStep({
        toolName: "file_read",
        toolCallId: "queued-external",
        args: { path: outside },
      }),
    );
    try {
      await collectChunks(
        agentLoopRuntime.streamRun(session.id, {
          message: "Inspect queued mode",
          permissionTier: "unrestricted",
          acceptedRunId: accepted.run.id,
        }),
      );
      expect(
        agentRuntimeStore.getSession(session.id).sessionMetadata
          ?.permissionTier,
      ).toBe("boundary");
      expect(JSON.stringify(capturedRequests[0].messages)).toContain(
        "Boundary approval",
      );
      expect(
        agentRuntimeStore
          .listPermissions(session.id)
          .some(
            (item) =>
              item.action === "ask" && item.internalGate === "external_path",
          ),
      ).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("applies a running session's new permission mode in the next step and prompt", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synax-next-step-"));
    const outside = path.join(dir, "outside.txt");
    fs.writeFileSync(outside, "requires a new approval");
    const session = agentSessionRuntime.create({
      projectId: "prompt-fixture",
      workDir: process.cwd(),
      profileId: "synax",
      prompt: "Inspect the files",
      permissionTier: "unrestricted",
      sessionMetadata: { mode: "chat" },
    });
    queueMockStep(
      makeToolStep({
        toolName: "file_read",
        toolCallId: "first-local",
        args: { path: "package.json" },
      }),
    );
    queueMockStep(
      makeToolStep({
        toolName: "file_read",
        toolCallId: "second-external",
        args: { path: outside },
      }),
    );
    let changed = false;
    try {
      for await (const chunk of agentLoopRuntime.streamRun(session.id, {
        message: "Inspect the files",
      })) {
        if (chunk.type === "tool_result" && !changed) {
          changed = true;
          applySessionPermissionUpdate(session.id, {
            permissionTier: "boundary",
          });
        }
      }
      expect(changed).toBe(true);
      expect(capturedRequests).toHaveLength(2);
      expect(JSON.stringify(capturedRequests[0].messages)).toContain(
        "Unrestricted tool permissions",
      );
      expect(JSON.stringify(capturedRequests[1].messages)).toContain(
        "Boundary approval",
      );
      expect(
        agentRuntimeStore
          .listPermissions(session.id)
          .some(
            (item) =>
              item.action === "ask" && item.internalGate === "external_path",
          ),
      ).toBe(true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps three Native requests prefix-identical as tool evidence and step state grow", async () => {
    const session = agentSessionRuntime.create({
      projectId: "prompt-fixture",
      workDir: process.cwd(),
      profileId: "synax",
      prompt: "请调查 package.json",
      sessionMetadata: { mode: "chat" },
    });
    queueMockStep(
      makeToolStep({
        toolName: "file_read",
        toolCallId: "read-one",
        args: { path: "package.json" },
      }),
    );
    queueMockStep(
      makeToolStep({
        toolName: "file_read",
        toolCallId: "read-two",
        args: { path: "tsconfig.json" },
      }),
    );
    queueMockStep(makeTextStep("已核对两个文件。"));
    await collectChunks(
      agentLoopRuntime.streamRun(session.id, {
        message: "请调查 package.json",
      }),
    );
    expect(capturedRequests).toHaveLength(3);
    for (let n = 1; n < 3; n++) {
      expect(capturedRequests[n].messages[0]).toEqual(
        capturedRequests[0].messages[0],
      );
      expect(capturedRequests[n].tools).toEqual(capturedRequests[0].tools);
      expect(capturedRequests[n].definitions).toEqual(
        capturedRequests[0].definitions,
      );
      const previous = capturedRequests[n - 1].messages;
      expect(capturedRequests[n].messages.slice(0, previous.length)).toEqual(
        previous,
      );
    }
    expect(String(capturedRequests[0].messages[0].content)).not.toContain(
      "Current work (authoritative runtime state)",
    );
    const steps = agentRuntimeStore.listSessionSteps(session.id);
    expect(steps).toHaveLength(3);
    const categories = steps.map(
      (step) =>
        step.metadata.contextComposition as {
          tools: number;
          messages: number;
          system: number;
          version: number;
        },
    );
    expect(categories[1].tools).toBeGreaterThan(categories[0].tools);
    expect(categories[2].tools).toBeGreaterThan(categories[1].tools);
    expect(categories.map((c) => c.messages)).toEqual([
      categories[0].messages,
      categories[0].messages,
      categories[0].messages,
    ]);
    expect(categories.every((c) => c.system > 0 && c.version === 2)).toBe(true);
    for (const [i, step] of steps.entries()) {
      expect(
        (step.metadata.runtimeReminder as { content: string }).content,
      ).toBe(capturedRequests[i].messages.at(-1)!.content);
      expect(step.metadata.runtimeReminderTokens).toBeGreaterThan(0);
      expect(
        (
          step.metadata.runtimeReminder as {
            historyAnchor?: { fingerprint: string };
          }
        ).historyAnchor?.fingerprint,
      ).toMatch(/^[a-f0-9]{64}$/);
      expect(
        (step.metadata.requestComposition as { historyAnchorStatus: string })
          .historyAnchorStatus,
      ).toBe(i === 0 ? "cold" : "matched");
    }
  });

  it("renders actual permission overrides and keeps forbidden operations gated", async () => {
    const session = agentSessionRuntime.create({
      projectId: "prompt-fixture",
      workDir: process.cwd(),
      profileId: "synax",
      prompt: "调查代码",
      permissionTier: "unrestricted",
      sessionMetadata: {
        source: "session-page",
        goalContent: "调查代码",
        mode: "chat",
      },
    });
    agentRuntimeStore.updateSession(session.id, {
      permissionRules: [
        { gate: "read", pattern: "*", action: "deny" },
        { gate: "shell", pattern: "*", action: "deny" },
      ],
    });
    queueMockStep(makeTextStep("读取权限受限。"));
    await collectChunks(
      agentLoopRuntime.streamRun(session.id, { message: "调查代码" }),
    );
    const text = JSON.stringify(capturedRequests[0].messages);
    expect(text).toContain("read denied");
    expect(text).not.toContain("Unrestricted tool permissions");
  });

  it("keeps tools available and puts advisory closing state in the runtime reminder", async () => {
    const session = agentSessionRuntime.create({
      projectId: "prompt-fixture",
      workDir: process.cwd(),
      profileId: "synax",
      prompt: "完成已有检查",
    });
    queueMockStep(
      makeToolStep({
        toolName: "task_create",
        toolCallId: "todo",
        args: { subject: "检查", description: "已有信息" },
      }),
    );
    queueMockStep(
      makeToolStep({
        toolName: "task_update",
        toolCallId: "done",
        args: { taskId: "1", status: "completed" },
      }),
    );
    queueMockStep(makeTextStep("已完成。"));
    await collectChunks(
      agentLoopRuntime.streamRun(session.id, { message: "完成已有检查" }),
    );
    const closing = capturedRequests.at(-1)!;
    expect(closing.tools).not.toContain("work_checkpoint");
    expect(closing.tools).toContain("bash");
    expect(closing.tools).not.toContain("verification_run");
    expect(closing.tools).toEqual(capturedRequests[0].tools);
    const system = String(closing.messages[0].content);
    expect(system).toBe(capturedRequests[0].messages[0].content);
    expect(system).not.toContain("Consider closing this round");
    const reminder = String(closing.messages.at(-1)!.content);
    expect(reminder).not.toContain('"status":"closing"');
    expect(reminder).toContain("Finish this turn with a concise answer");
  });
});
