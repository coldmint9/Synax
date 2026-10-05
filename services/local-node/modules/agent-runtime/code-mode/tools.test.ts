import type { CodeResult } from "./contracts.js";
import type { CodeModeSettings } from "../../../infrastructure/runtime/config/project-settings-types.js";
import { createServer } from "node:http";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { mcpClientManager } from "../../../infrastructure/mcp/mcp-client-manager.js";
import { warmupMcpForSession } from "../../../infrastructure/mcp/mcp-session-tool-provider.js";
import { permissionPolicy } from "../permission-policy.js";
import { revokeProjectToolGrant } from "../project-tool-grants.js";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { agentRuntimeStore as store } from "../session-store.js";
import { agentSessionRuntime } from "../session-runtime.js";
import { ToolRegistry } from "../tool-registry.js";
import { profileService } from "../profile-service.js";
import { ensureSynaxAgentRegistered } from "../synax/index.js";
import { resetAgentRuntimeFixtures } from "../__tests__/agent-runtime-fixtures.js";
import {
  setSessionWorkspaceRoot,
  clearSessionWorkspaceRoot,
} from "../tools/workspace.js";
import {
  getProjectSettings,
  updateProjectSettings,
} from "../../../infrastructure/runtime/config/project-settings-store.js";
import { canComposeTool } from "./policy.js";
import { codeParentId } from "./history.js";
import {
  createLoopHistoryReader,
  buildLoopModelMessages,
} from "../loop-model-messages.js";
import { buildLoopToolSet } from "../loop-ai-tools.js";
import { extensionStore } from "../../extensions/extension-store.js";
import { withSandboxApproval } from "../sandbox/sandbox-policy.js";
import type { RegisteredTool } from "../contracts.js";

let dir: string, id: string, registry: ToolRegistry;
const projectId = "code-mode-test";
const run = async (code: string) =>
  (await registry.execute(id, "code.run", { code })).toolResult
    ?.result as CodeResult & { executionId: string; nextAction?: string };
beforeEach(() => {
  resetAgentRuntimeFixtures();
  ensureSynaxAgentRegistered();
  registry = new ToolRegistry();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "synax-code-"));
  fs.mkdirSync(path.join(dir, "workspace"));
  fs.writeFileSync(
    path.join(dir, "workspace", "a.txt"),
    "intermediate-private-data",
  );
  fs.writeFileSync(path.join(dir, "outside.txt"), "outside");
  id = agentSessionRuntime.create({
    projectId,
    profileId: "synax",
    prompt: "Code mode test",
    permissionTier: "boundary",
  }).id;
  setSessionWorkspaceRoot(id, path.join(dir, "workspace"));
  updateProjectSettings(
    projectId,
    { codeMode: { enabled: true, mcpTools: [] } },
    "test",
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  clearSessionWorkspaceRoot(id);
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("Code Mode runtime bridge", () => {
  it("is disabled by default, opt-in per project, and obeys the global kill switch", async () => {
    expect(getProjectSettings("code-default-project").codeMode?.enabled).toBe(
      false,
    );
    expect(registry.listForSession(id).map((t) => t.id)).toContain("code.run");
    vi.stubEnv("SYNAX_CODE_MODE", "0");
    expect(registry.listForSession(id).map((t) => t.id)).not.toContain(
      "code.run",
    );
    expect(
      (await registry.execute(id, "code.run", { code: "return 1" })).record
        .status,
    ).toBe("denied");
  });
  it("discovers schemas and executes through the registry with an audit trail, not model history", async () => {
    const discovery = await registry.execute(id, "code.tools", {
      toolId: "file.read",
    });
    expect(discovery.toolResult?.result).toMatchObject({
      id: "file.read",
      inputSchema: { type: "object" },
    });
    const result = await run(
      'const data=await tools.call("file.read",{path:"a.txt"}); return {found:Boolean(data)};',
    );
    expect(result.status).toBe("completed");
    expect(result.value).toEqual({ found: true });
    const records = store.listToolCalls(id);
    const nested = records.find((r) => codeParentId(r));
    expect(nested?.toolId).toBe("file.read");
    expect(codeParentId(nested!)).toBe(result.executionId);
    expect(JSON.stringify(nested?.outputRef)).toContain(
      "intermediate-private-data",
    );
    expect(
      createLoopHistoryReader(store, id)
        .listToolCalls()
        .some((r) => codeParentId(r)),
    ).toBe(false);
    const messages = buildLoopModelMessages(
      store,
      id,
      buildLoopToolSet(registry.listForSession(id)),
    );
    expect(JSON.stringify(messages)).not.toContain("intermediate-private-data");
    expect(JSON.stringify(result)).not.toContain("intermediate-private-data");
  });
  it("denies writes, recursion and non-mounted tools without executing them", async () => {
    for (const tool of [
      "file.write",
      "bash",
      "code.run",
      "subagent.delegate",
      "mcp.other.read",
    ]) {
      expect(
        (await run(`return await tools.call(${JSON.stringify(tool)},{});`))
          .status,
      ).toBe("denied");
    }
    expect(store.listToolCalls(id).every((r) => r.toolId === "code.run")).toBe(
      true,
    );
  });
  it("fails closed on asks and never changes the session into waiting_permission", async () => {
    const result = await run(
      'return await tools.call("file.read",{path:"../outside.txt"});',
    );
    expect(result.status).toBe("denied");
    expect(store.getSession(id).status).not.toBe("waiting_permission");
    const nested = store.listToolCalls(id).find((r) => codeParentId(r))!;
    expect(nested.status).toBe("denied");
    expect(nested.error).toMatch(/directly/);
    expect(
      store
        .listPermissions(id)
        .find((p) => p.id === nested.permissionDecisionId)?.action,
    ).toBe("deny");
    // The normal direct approval path remains intact.
    expect(
      (await registry.execute(id, "file.read", { path: "../outside.txt" }))
        .permission?.action,
    ).toBe("ask");
  });
  it("does not inherit sandbox approvals from the outer tool", async () => {
    const result = await withSandboxApproval(id, [dir], () =>
      run('return await tools.call("file.read",{path:"../outside.txt"});'),
    );
    expect(result.status).toBe("denied");
  });
  it("rejects invalid tool arguments and reports a recoverable failure", async () => {
    const result = await run(
      'return await tools.call("file.read",{maxBytes:-5});',
    );
    expect(result.status).toBe("failed");
    expect(result.nextAction).toContain("direct tools");
  });
  it("rechecks disabled tools between calls", async () => {
    registry.register({
      ...registry.get("file.list"),
      execute: () => {
        extensionStore.setState(projectId, "tool", "file.read", {
          installed: true,
          enabled: false,
        });
        return { result: [], displaySummary: "[]", artifacts: [] };
      },
    });
    expect(
      (
        await run(
          'await tools.call("file.list",{}); return await tools.call("file.read",{path:"a.txt"});',
        )
      ).status,
    ).toBe("denied");
  });
  it("requires both administrator allowlisting and an explicit read-only MCP annotation", async () => {
    const execute = vi.fn(async () => ({
      result: { ok: true, items: [1, 2] },
      displaySummary: "2 items",
      artifacts: [],
    }));
    const tool: RegisteredTool = {
      id: "mcp.trusted.list",
      label: "List",
      description: "List",
      category: "mcp",
      mutability: "read",
      codeModeReadOnly: true,
      resumeBehavior: "none",
      execute,
    };
    registry.register(tool);
    expect(canComposeTool(store.getSession(id), tool)).toBe(false);
    updateProjectSettings(
      projectId,
      { codeMode: { mcpTools: [tool.id] } },
      "test",
    );
    expect(canComposeTool(store.getSession(id), tool)).toBe(true);
    expect(
      canComposeTool(store.getSession(id), {
        ...tool,
        codeModeReadOnly: false,
      }),
    ).toBe(false);
    expect(
      canComposeTool(store.getSession(id), { ...tool, mutability: "task" }),
    ).toBe(false);
    // Listing is not authorization: the existing MCP permission gate still asks.
    const first = await run('return await tools.call("mcp.trusted.list",{});');
    expect(first.status).toBe("denied");
    expect(execute).not.toHaveBeenCalled();
  });
  it("enforces profile capability filtering even with Code Mode enabled", async () => {
    const explorer = agentSessionRuntime.create({
      projectId,
      profileId: "explorer",
      prompt: "Explore",
    });
    expect(
      (await registry.execute(explorer.id, "code.run", { code: "return 1" }))
        .record.status,
    ).toBe("failed");
    expect(
      profileService.getForSession(store.getSession(id)).mountAllTools,
    ).toBe(true);
  });
  it("validates saved config instead of accepting model-provided limits/wildcards", () => {
    expect(() =>
      updateProjectSettings(
        projectId,
        { codeMode: { enabled: "yes" as unknown as boolean } },
        "test",
      ),
    ).toThrow();
    expect(() =>
      updateProjectSettings(
        projectId,
        { codeMode: { mcpTools: ["*"] } },
        "test",
      ),
    ).toThrow();
    expect(() =>
      updateProjectSettings(
        projectId,
        { codeMode: { timeoutMs: 1e9 } as unknown as CodeModeSettings },
        "test",
      ),
    ).toThrow();
  });
});

it("composes real MCP over HTTP, honors grant revocation and project/session isolation", async () => {
  let invocations = 0;
  const http = createServer(async (request, response) => {
    const server = new McpServer({
      name: "codemode-fixture",
      version: "1.0.0",
    });
    server.registerTool(
      "read",
      { annotations: { readOnlyHint: true }, description: "Read fixture rows" },
      async () => {
        invocations++;
        return {
          content: [{ type: "text", text: "rows" }],
          structuredContent: { items: [1, 2, 3] },
        };
      },
    );
    server.registerTool(
      "write",
      { annotations: { readOnlyHint: false } },
      async () => ({ content: [] }),
    );
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
      enableJsonResponse: true,
    });
    response.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(request, response);
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const port = (http.address() as { port: number }).port;
  try {
    updateProjectSettings(
      projectId,
      {
        mcpServers: [
          {
            id: "codemode",
            name: "Code fixture",
            command: "",
            transport: "http",
            url: `http://127.0.0.1:${port}/mcp`,
          },
        ],
        codeMode: {
          enabled: true,
          mcpTools: ["mcp.codemode.read", "mcp.codemode.write"],
        },
      },
      "test",
    );
    store.updateSession(id, { mcpServerIds: ["codemode"] });
    await warmupMcpForSession(id);
    const discover = (
      await registry.execute(id, "code.tools", { query: "mcp." })
    ).toolResult?.result as { tools: Array<{ id: string }> };
    expect(discover.tools.map((t) => t.id)).toEqual(["mcp.codemode.read"]);
    const request = await registry.execute(id, "mcp.codemode.read", {});
    expect(request.permission?.action).toBe("ask");
    permissionPolicy.reply(id, request.permission!.id, "always");
    const result = await run(
      'const data=await tools.call("mcp.codemode.read",{}); return data.structuredContent.items.reduce((a,b)=>a+b,0);',
    );
    expect(result.status).toBe("completed");
    expect(result.value).toBe(6);
    expect(invocations).toBe(1);
    revokeProjectToolGrant(projectId, "mcp.codemode.read");
    expect(
      (await run('return await tools.call("mcp.codemode.read",{});')).status,
    ).toBe("denied");
    expect(invocations).toBe(1);
    store.updateSession(id, { mcpServerIds: [] });
    expect(
      (await run('return await tools.call("mcp.codemode.read",{});')).status,
    ).toBe("denied");
    const other = agentSessionRuntime.create({
      projectId: "code-mode-other-project",
      profileId: "synax",
      prompt: "Isolation",
      mcpServerIds: ["codemode"],
    });
    setSessionWorkspaceRoot(other.id, path.join(dir, "workspace"));
    updateProjectSettings(
      "code-mode-other-project",
      { codeMode: { enabled: true, mcpTools: ["mcp.codemode.read"] } },
      "test",
    );
    expect(
      (await registry.execute(other.id, "code.tools", { query: "mcp." }))
        .toolResult?.result,
    ).toMatchObject({ total: 0 });
    clearSessionWorkspaceRoot(other.id);
  } finally {
    mcpClientManager.closeAll();
    http.closeAllConnections();
    await new Promise<void>((resolve) => http.close(() => resolve()));
  }
}, 15000);

it("closes nested audit records when a read ignores cancellation", async () => {
  const controller = new AbortController();
  registry.register({
    ...registry.get("file.list"),
    execute: () => {
      controller.abort();
      return new Promise(() => {});
    },
  });
  await registry.execute(
    id,
    "code.run",
    { code: 'return await tools.call("file.list",{});' },
    { abortSignal: controller.signal },
  );
  expect(
    store
      .listToolCalls(id)
      .filter((r) => codeParentId(r))
      .every((r) => r.status !== "running"),
  ).toBe(true);
});
