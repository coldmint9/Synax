import { beforeEach, expect, it } from "vitest";
import { admitActiveFixtureRun, executorInput, resetAgentRuntimeFixtures } from "./agent-runtime-fixtures.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore as store } from "../session-store.js";
import { persistNativeRuntimeReminder } from "../native-runtime-reminder.js";
import { prepareCheckpointContext } from "../checkpoint-projection.js";
import { restartTestRuntime } from "../../../../test-fixtures/rust-runtime.js";

beforeEach(resetAgentRuntimeFixtures);

it("replays runtime snapshots as an unchanged input prefix across retries, rounds and recovery", async () => {
  const session = agentSessionRuntime.create(executorInput);
  const run = await admitActiveFixtureRun(session.id);
  const step = { id: "step-one", sessionId: session.id, runId: run.id };
  const first = persistNativeRuntimeReminder(step, ["Work evidence: first receipt"]);
  store.appendMessage({ id: "reply", sessionId: session.id, runId: run.id, stepId: step.id,
    role: "assistant", content: "Continue checking", metadata: {}, createdAt: new Date().toISOString() });
  expect(persistNativeRuntimeReminder(step, ["Changed state must not replace old evidence"])).toEqual(first);
  const next = persistNativeRuntimeReminder({ ...step, id: "step-two", runId: "next-round" }, ["Work evidence: first and second receipts"]);
  await store.flushSession(session.id);

  const project = () => prepareCheckpointContext({
    sessionId: session.id, projectId: session.projectId,
    systemPrompt: "Stable instructions", tools: [], budget: { contextLimit: 20_000, outputReserve: 256 },
    resolve: async message => [message.metadata.rustMessage ?? { role: message.role, content: message.content }],
  });
  const before = await project();
  expect(before.prompt).toEqual([
    first!.metadata.rustMessage,
    { role: "assistant", content: "Continue checking" },
    next!.metadata.rustMessage,
  ]);
  expect(store.listMessages(session.id).filter(message => message.role === "user")).toHaveLength(0);

  await restartTestRuntime();
  store.reset();
  await store.hydrateExecutionSession(session.id, true);
  expect(persistNativeRuntimeReminder(step, ["Recovery must not rewrite the earlier snapshot"])).toEqual(first);
  expect((await project()).prompt).toEqual(before.prompt);
}, 20_000);
