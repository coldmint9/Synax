import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getRawSqlite } from "../../../db/index.js";
import { clearVersionSessionFixture } from "./version-session-fixture.js";
import { runWithExecutionContext } from "../../../lib/execution-context.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore as store } from "../session-store.js";
import {
  buildLoopModelMessages,
  createLoopHistoryReader,
} from "../loop-model-messages.js";
import { initializeVersionNative } from "../checkpoints/version-runtime/bridge.js";
import { readHistoryWindow } from "../checkpoints/version-runtime/window.js";
import { toModelPrompt } from "../../llm-runtime/prompt.js";
import { workRuntime } from "../work-runtime.js";
import { workStore } from "../work-store.js";
import {
  plannerSessionInput,
  resetAgentRuntimeFixtures,
} from "./agent-runtime-fixtures.js";

const tools = { resolveModelToolName: (id: string) => id };

describe.each(["boundary", "full", "legacy"])(
  "%s execution history integrity",
  (mode) => {
    let sessionId: string;
    beforeEach(() => {
      vi.stubEnv(
        "SYNAX_VERSION_HISTORY",
        mode === "boundary" ? "boundary" : "legacy",
      );
      resetAgentRuntimeFixtures();
      const session = agentSessionRuntime.create({
        ...plannerSessionInput,
        workDir: process.cwd(),
      });
      sessionId = session.id;
      if (mode === "full") {
        store.updateSession(sessionId, { status: "completed" });
        initializeVersionNative(
          store.getSession(sessionId),
          store.listEvents(sessionId),
          session.contextSnapshotId
            ? store.getContextBundle(session.contextSnapshotId)
            : undefined,
        );
      }
    });
    afterEach(() => {
      vi.restoreAllMocks();
      clearVersionSessionFixture(sessionId);
      vi.unstubAllEnvs();
    });

    function message(
      id: string,
      role: "user" | "assistant",
      content = id,
      runId: string | null = null,
    ) {
      return store.appendMessage({
        id,
        sessionId,
        runId,
        stepId: null,
        role,
        content,
        metadata: { source: "turn_request" },
        createdAt: id,
      });
    }
    function run(id: string, triggerMessageId: string | null = null) {
      return store.appendRun({
        id,
        sessionId,
        triggerMessageId,
        status: "running",
        startedAt: id,
        completedAt: null,
        currentStep: 0,
        stopReason: null,
        model: null,
        metadata: {},
      });
    }

    it("keeps the real user request after more than 256 assistant records, without previewing its text", () => {
      const content = "Real user requirement. ".repeat(500);
      message("user", "user", content);
      for (let i = 0; i < 270; i++) message(`assistant-${i}`, "assistant");
      const messages = buildLoopModelMessages(store, sessionId, tools);
      expect(toModelPrompt(messages).messages).toEqual([
        { role: "user", content, providerOptions: undefined },
      ]);
      expect(store.listMessages(sessionId)).toHaveLength(271);
      if (mode !== "legacy") {
        const window = readHistoryWindow(sessionId);
        expect(window.messages).toHaveLength(24);
        expect(window.historyWindow.olderCursor).toBeTruthy();
      }
    }, 20_000);

    it("keeps every run, step and part instead of silently dropping older entries", () => {
      for (let i = 0; i < 270; i++) run(`run-${String(i).padStart(3, "0")}`);
      for (let i = 0; i < 270; i++) {
        store.appendRunStep({
          id: `step-${i}`,
          sessionId,
          runId: "run-000",
          index: i,
          status: "completed",
          model: null,
          startedAt: "now",
          completedAt: "now",
          finishReason: "stop",
          metadata: {},
        });
        store.appendRunPart({
          id: `part-${i}`,
          sessionId,
          runId: "run-000",
          stepId: "step-0",
          kind: "text",
          sequence: i,
          content: `part ${i}`,
          toolCallId: null,
          metadata: {},
          createdAt: "now",
        });
      }
      const history = createLoopHistoryReader(store, sessionId);
      expect(history.listRuns()).toHaveLength(270);
      expect(history.listRunSteps("run-000")).toHaveLength(270);
      expect(history.listRunParts("step-0")).toHaveLength(270);
    }, 20_000);

    it("does not spend a shared read budget on steps and then silently erase the user request", () => {
      message("user", "user", "Keep this request");
      run("run", "user");
      for (let i = 0; i < 4; i++)
        store.appendRunStep({
          id: `step-${i}`,
          sessionId,
          runId: "run",
          index: i,
          status: "completed",
          model: null,
          startedAt: "now",
          completedAt: "now",
          finishReason: "stop",
          metadata: { evidence: "x".repeat(300_000) },
        });
      const history = createLoopHistoryReader(store, sessionId);
      expect(history.listRunSteps("run")).toHaveLength(4);
      expect(history.listMessages().map((m) => m.content)).toEqual([
        "Keep this request",
      ]);
    });

    it("reads all tool evidence without previewing arguments or results", () => {
      run("run");
      store.appendRunStep({
        id: "step",
        sessionId,
        runId: "run",
        index: 1,
        status: "completed",
        model: null,
        startedAt: "now",
        completedAt: "now",
        finishReason: "tool-calls",
        metadata: {},
      });
      const evidence = "Full evidence, not a display preview. ".repeat(300);
      for (let i = 0; i < 270; i++)
        store.appendToolCall({
          id: `tool-${i}`,
          sessionId,
          runId: "run",
          stepId: "step",
          modelToolCallId: `call-${i}`,
          toolId: "file.read",
          category: "read",
          mutability: "read",
          argsHash: "hash",
          inputSummary: "read",
          inputRef: { path: `${i}.txt` },
          outputSummary: "read result",
          outputRef: { text: evidence },
          status: "completed",
          permissionDecisionId: null,
          startedAt: "now",
          endedAt: "now",
          error: null,
        });
      const history = createLoopHistoryReader(store, sessionId);
      expect(history.listRunToolCalls("run")).toHaveLength(270);
      expect(history.listToolCalls()).toEqual(history.listRunToolCalls("run"));
      expect(
        history
          .listToolCalls()
          .every(
            (call) => (call.outputRef as { text: string }).text === evidence,
          ),
      ).toBe(true);
    }, 20_000);

    it("merges metadata under the writer lock and still allows explicit field removal", () => {
      const current = run("metadata-run");
      store.updateRun(current.id, {
        metadata: {
          workId: "keep",
          goalExecutionId: "remove",
          recovery: { phase: "saved" },
        },
      });
      const read = store.getRun.bind(store);
      const spy = vi.spyOn(store, "getRun").mockImplementation((id) => {
        expect(getRawSqlite().inTransaction).toBe(true);
        return read(id);
      });
      const updated = store.updateRun(current.id, {
        metadata: { goalExecutionId: undefined },
      });
      spy.mockRestore();
      expect(updated.metadata).toMatchObject({
        workId: "keep",
        recovery: { phase: "saved" },
      });
      expect(store.getRun(current.id).metadata).not.toHaveProperty(
        "goalExecutionId",
      );
    });

    it("does not erase the active lease when starting a new work after a completed turn", () => {
      message("first-user", "user", "First task");
      const first = run("first", "first-user");
      const previous = workRuntime.attach(sessionId, first);
      workStore.save({ ...previous, status: "completed", result: "Done" });
      store.updateRun(first.id, { status: "completed" });
      message("second-user", "user", "Implement a different feature");
      const second = run("second", "second-user");
      const context = {
        sessionId,
        runId: second.id,
        epoch: "lease",
        hostId: "test",
      };
      const lease = { ...context, closed: false };
      store.updateRun(second.id, { metadata: { executionLease: lease } });
      runWithExecutionContext(context, () => {
        workRuntime.attach(sessionId, store.getRun(second.id));
        store.updateSession(sessionId, { title: "Second turn is writable" });
      });
      expect(store.getRun(second.id).metadata.executionLease).toEqual(lease);
      if (mode !== "legacy")
        expect(
          store.listRuns(sessionId).find((r) => r.id === second.id)?.metadata,
        ).not.toHaveProperty("executionLease");
      store.updateRun(second.id, {
        metadata: { executionLease: { ...lease, closed: true } },
      });
      expect(() =>
        runWithExecutionContext(context, () =>
          store.updateSession(sessionId, { title: "Stale write" }),
        ),
      ).toThrow(/superseded or closed/);
      expect(store.getSession(sessionId).title).toBe("Second turn is writable");
    });
  },
);
