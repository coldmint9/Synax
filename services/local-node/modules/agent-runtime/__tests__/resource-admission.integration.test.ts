import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { runWithExecutionContext } from "../../../infrastructure/runtime/execution-context.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { runtimeFacade } from "../sidecar/runtime-facade.js";
import { withToolResource } from "../resource-admission.js";
import type { RegisteredTool, ToolExecutionInput, ToolExecutionProgress } from "../contracts.js";
import { admitActiveFixtureRun, executorInput, resetAgentRuntimeFixtures } from "./agent-runtime-fixtures.js";

it("runs four commands from one root concurrently and admits inspection and external work alongside them", async () => {
  await resetAgentRuntimeFixtures();
  const session = agentSessionRuntime.create(executorInput);
  const run = await admitActiveFixtureRun(session.id);
  const context = { sessionId: session.id, runId: run.id, epoch: randomUUID(), hostId: "concurrent-resource-test" };
  await runtimeFacade.controlCommand({ sessionId: session.id, requestId: randomUUID(), operation: "execution_open", payload: context });
  const tool = { id: "bash", category: "shell", mutability: "read" } as RegisteredTool;
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(new Error("Commands were serialized within one root")), 10_000);
  const input = { sessionId: session.id, runId: run.id, toolCallId: "parallel", args: { command: "sleep 1" }, abortSignal: abort.signal } as ToolExecutionInput;
  let release!: () => void;
  let allEntered!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { allEntered = resolve; });
  let active = 0;
  const commands = Array.from({ length: 4 }, (_, index) => runWithExecutionContext(context, () => withToolResource(
    tool, { ...input, toolCallId: `parallel-${index}` }, () => {}, async () => {
      if (++active === 4) allEntered();
      await held;
      active--;
    },
  )));
  const finished = Promise.all(commands);
  void finished.catch(() => {});
  try {
    await Promise.race([entered, finished]);
    expect(active).toBe(4);
    for (const command of ["git status --short", "sed -n 1,20p package.json"]) {
      const result = await runWithExecutionContext(context, () => withToolResource(tool,
        { ...input, args: { command } }, () => {}, async () => "inspected"));
      expect(result).toBe("inspected");
      expect(active).toBe(4);
    }
    const external = await runWithExecutionContext(context, () => withToolResource(
      { id: "fixture.external", category: "mcp", mutability: "read" } as RegisteredTool,
      input, () => {}, async () => "external completed"));
    expect(external).toBe("external completed");
    expect(active).toBe(4);
  } finally {
    clearTimeout(deadline);
    release();
    await Promise.allSettled(commands);
  }
}, 20_000);

it("admits inspection in the same session while a long command owns its Rust permit", async () => {
  await resetAgentRuntimeFixtures();
  const session = agentSessionRuntime.create(executorInput);
  const run = await admitActiveFixtureRun(session.id);
  const context = { sessionId: session.id, runId: run.id, epoch: randomUUID(), hostId: "resource-test" };
  await runtimeFacade.controlCommand({ sessionId: session.id, requestId: randomUUID(), operation: "execution_open", payload: context });
  const tool = { id: "bash", category: "shell", mutability: "read" } as RegisteredTool;
  const abort = new AbortController();
  const deadline = setTimeout(() => abort.abort(new Error("Inspection waited behind the build")), 3_000);
  const input = { sessionId: session.id, runId: run.id, toolCallId: "build", args: { command: "cargo build --release" }, abortSignal: abort.signal } as ToolExecutionInput;
  let release!: () => void;
  let enter!: () => void;
  let finished = false;
  const held = new Promise<void>(resolve => { release = resolve; });
  const entered = new Promise<void>(resolve => { enter = resolve; });
  const command = runWithExecutionContext(context, () => withToolResource(tool, input, () => {}, async () => {
    enter(); await held; finished = true;
  }));
  void command.catch(() => {});
  try {
    await Promise.race([entered, command]);
    const progress: ToolExecutionProgress[] = [];
    const result = await runWithExecutionContext(context, () => withToolResource(tool,
      { ...input, toolCallId: "inspect", args: { command: "cd runtime-sidecar && rg needle src | head" } },
      state => progress.push(state), () => "inspected",
    ));
    expect(result).toBe("inspected");
    expect(finished).toBe(false);
    expect(progress.at(-1)).toMatchObject({ phase: "executing_tool", resource: "search", queueWaitMs: 0 });
  } finally {
    clearTimeout(deadline);
    release();
    await command;
  }
}, 15_000);
