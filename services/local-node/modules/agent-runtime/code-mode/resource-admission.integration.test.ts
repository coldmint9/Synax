import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { expect, it, vi } from "vitest";
import { agentSessionRuntime } from "../session-runtime.js";
import { runtimeFacade } from "../sidecar/runtime-facade.js";
import { withToolResource } from "../resource-admission.js";
import { runWithExecutionContext, type RuntimeExecutionContext } from "../../../infrastructure/runtime/execution-context.js";
import type { RegisteredTool, ToolExecutionInput } from "../contracts.js";
import { admitActiveFixtureRun, executorInput, resetAgentRuntimeFixtures } from "../__tests__/agent-runtime-fixtures.js";

// Each process imports the production executor and resource adapter, sharing
// only the sidecar endpoint and its own execution lease with its parent.
const childSource = `
import {runWithExecutionContext} from ${JSON.stringify(new URL("../../../infrastructure/runtime/execution-context.ts", import.meta.url).href)};
import {withToolResource} from ${JSON.stringify(new URL("../resource-admission.ts", import.meta.url).href)};
import {executeCode} from ${JSON.stringify(new URL("./executor.ts", import.meta.url).href)};
import {codeWorkerPool} from ${JSON.stringify(new URL("./worker-pool.ts", import.meta.url).href)};
const context=JSON.parse(process.env.CODE_REVIEW_CONTEXT);
const controller=new AbortController();
const held=Promise.withResolvers();
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
process.stdin.on('data',data=>{
  if(data.toString().includes('cancel')) controller.abort(new Error('cancelled by fixture'));
  else held.resolve();
});
try {
  const result=await runWithExecutionContext(context,()=>withToolResource(
    {id:'agent.execute',category:'read',mutability:'read'},
    {...context,toolCallId:'code-'+process.pid,args:{},abortSignal:controller.signal},
    state=>send({event:state.phase,resource:state.resource}),
    signal=>executeCode({code:'return await tools.call("fixture.read",{});',signal,callTool:async()=>{
      send({event:'started',pid:process.pid});await held.promise;return true;
    }})
  ));
  send({event:'done',status:result.status});
} catch(error) {send({event:'done',status:controller.signal.aborted?'cancelled':'failed',error:String(error)});}
finally {await codeWorkerPool.close();process.stdin.destroy();}
`;

class CodeChild {
  readonly child: ChildProcessWithoutNullStreams;
  readonly events: Array<{ event: string; status?: string; error?: string }> = [];
  private readonly changes = new EventEmitter();
  private error = "";
  private ended = false;
  readonly closed: Promise<void>;

  constructor(context: RuntimeExecutionContext) {
    this.child = spawn(process.execPath, ["--import", "tsx/esm", "--input-type=module", "--eval", childSource], {
      env: { ...process.env, CODE_REVIEW_CONTEXT: JSON.stringify(context), SYNAX_PROCESS_OWNER: `review-${randomUUID()}` },
      stdio: ["pipe", "pipe", "pipe"],
    });
    this.child.stdin.on("error", () => {});
    let output = "";
    this.child.stdout.on("data", chunk => {
      output += String(chunk);
      let newline: number;
      while ((newline = output.indexOf("\n")) >= 0) {
        const line = output.slice(0, newline); output = output.slice(newline + 1);
        try { const value = JSON.parse(line); if (value.event) this.events.push(value); }
        catch { this.error += line; }
      }
      this.changes.emit("change");
    });
    this.child.stderr.on("data", chunk => { this.error = (this.error + String(chunk)).slice(-4000); });
    this.child.on("error", error => { this.error = String(error); this.ended = true; this.changes.emit("change"); });
    this.closed = new Promise(resolve => this.child.once("close", () => {
      this.ended = true; this.changes.emit("change"); resolve();
    }));
  }

  wait(event: string) {
    return new Promise<(typeof this.events)[number]>((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error(`No ${event}: ${this.error}`)), 8_000);
      const finish = (value: (typeof this.events)[number] | Error) => {
        clearTimeout(timer); this.changes.off("change", check);
        if (value instanceof Error) reject(value); else resolve(value);
      };
      const check = () => {
        const found = this.events.find(item => item.event === event);
        if (found) finish(found);
        else if (this.ended) finish(new Error(`Exited before ${event}: ${this.error}`));
      };
      this.changes.on("change", check); check();
    });
  }
}

it("shares code permits across session processes without blocking ordinary I/O, and cancels queued code", async () => {
  vi.stubEnv("SYNAX_RESOURCE_CODE_LIMIT", "2");
  const children: CodeChild[] = [];
  try {
    await resetAgentRuntimeFixtures();
    const contexts: RuntimeExecutionContext[] = [];
    for (let i = 0; i < 4; i++) {
      const session = agentSessionRuntime.create(executorInput);
      const run = await admitActiveFixtureRun(session.id);
      const context = { sessionId: session.id, runId: run.id, epoch: randomUUID(), hostId: "code-process-review" };
      await runtimeFacade.controlCommand({ sessionId: session.id, requestId: randomUUID(), operation: "execution_open", payload: context });
      contexts.push(context);
    }
    const start = (index: number) => { const child = new CodeChild(contexts[index]); children.push(child); return child; };
    const first = start(0), second = start(1);
    await Promise.all([first.wait("started"), second.wait("started")]);
    expect(first.child.pid).not.toBe(second.child.pid);
    const queued = start(2);
    await queued.wait("queued_resources");
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(queued.events.some(event => event.event === "started")).toBe(false);
    // A different conversation can still inspect files while both code slots wait for tools.
    const inspected = await runWithExecutionContext(contexts[3], () => withToolResource(
      { id: "file.read", category: "read", mutability: "read" } as RegisteredTool,
      { ...contexts[3], stepId: null, toolCallId: "inspection", toolId: "file.read", category: "read", mutability: "read",
        args: {}, abortSignal: AbortSignal.timeout(3_000) } satisfies ToolExecutionInput,
      () => {}, async () => "inspected",
    ));
    expect(inspected).toBe("inspected");
    queued.child.stdin.write("cancel\n");
    expect(await queued.wait("done")).toMatchObject({ status: "cancelled" });
    expect(queued.events.some(event => event.event === "started")).toBe(false);
    await queued.closed;
    const next = start(3);
    await next.wait("queued_resources");
    first.child.stdin.write("release\n");
    expect(await first.wait("done")).toMatchObject({ status: "completed" });
    await next.wait("started");
    second.child.stdin.write("release\n"); next.child.stdin.write("release\n");
    for (const child of [second, next]) expect(await child.wait("done")).toMatchObject({ status: "completed" });
  } finally {
    for (const child of children) if (child.child.exitCode === null) child.child.kill("SIGKILL");
    await Promise.all(children.map(child => child.closed));
    vi.unstubAllEnvs();
  }
}, 30_000);
