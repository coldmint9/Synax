import {
  hasInlineMedia,
  importToolContent,
} from "../agent-runtime/media-tool-content.js";
import type { RuntimeContentPart } from "../agent-runtime/content-parts.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createMcpTransport } from "./mcp-transport.js";
import { extensionStore } from "../extensions/extension-store.js";

import { readWorkspaceProject, projectSourceLocation } from "../project-workspace.js";
import { workspaceLocationHostPath } from "../workspace-location.js";
import type { McpServerConfig } from "../../lib/config/config-types.js";
import { getGlobalConfigForRuntime } from "../../lib/config/config-store.js";
import { getProjectSettings } from "../../lib/config/project-settings-store.js";
import { logger } from "../../lib/logger.js";

export interface McpRuntimeToolDef {
  name: string;
  title?: string;
  description?: string;
  readOnlyHint?: boolean;
}

const START_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 60_000;

type ServerState =
  | { status: "idle" }
  | { status: "starting" }
  | {
      status: "ready";
      client: Client;
      transport: Transport;
      tools: McpRuntimeToolDef[];
    }
  | { status: "failed"; error: string };

function sanitizeName(value: string): string {
  return value.replace(/[^a-zA-Z0-9._:-]/g, "_").slice(0, 96);
}

function toToolDefs(
  tools: Array<Record<string, unknown>>,
): McpRuntimeToolDef[] {
  return (tools ?? [])
    .map((tool) => ({
      name: typeof tool.name === "string" ? tool.name : "",
      title: typeof tool.title === "string" ? tool.title : undefined,
      description:
        typeof tool.description === "string" ? tool.description : undefined,
      readOnlyHint: Boolean(
        (tool.annotations as Record<string, unknown> | undefined)?.readOnlyHint,
      ),
    }))
    .filter((tool) => tool.name);
}

function toText(content: unknown): string {
  if (!Array.isArray(content))
    return typeof content === "string"
      ? content
      : JSON.stringify(content ?? {});
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (rec.type === "text" && typeof rec.text === "string")
      parts.push(rec.text);
    else if (
      rec.type === "resource" &&
      rec.resource &&
      typeof rec.resource === "object"
    ) {
      const res = rec.resource as Record<string, unknown>;
      if (typeof res.text === "string") parts.push(res.text);
      else parts.push(JSON.stringify(res));
    } else if (rec.type === "image" && typeof rec.data === "string") {
      throw new Error("Image results require structured media handling.");
    } else {
      try {
        parts.push(JSON.stringify(rec));
      } catch {
        /* ignore */
      }
    }
  }
  return parts.join("\n");
}

export class McpClientManager {
  private readonly servers = new Map<string, ServerState>();
  private readonly inflight = new Map<string, Promise<ServerState>>();

  private configById(projectId?: string): Map<string, McpServerConfig> {
    // MCP is project-scoped. Keep the global list only for backward-compatible
    // probe/config reads; never make global servers available to Agent runs.
    if (projectId) {
      const project = getProjectSettings(projectId, true);
      return new Map(
        (project.mcpServers ?? []).map((server) => [server.id, server]),
      );
    }
    const config = getGlobalConfigForRuntime();
    return new Map(
      (config?.mcpServers ?? []).map((server) => [server.id, server]),
    );
  }

  private async startServer(config: McpServerConfig, projectId?: string): Promise<ServerState> {
    const key = JSON.stringify([projectId ?? null, config.id]);
    const existing = this.servers.get(key);
    if (existing?.status === "ready") return existing;
    if (existing?.status === "starting") {
      const pending = this.inflight.get(key);
      if (pending) return pending;
    }

    const promise = (async (): Promise<ServerState> => {
      let transport: Transport | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const project = projectId ? readWorkspaceProject(projectId) : undefined;
        const location = project ? projectSourceLocation(project) : undefined;
        if (config.transport !== "http" && projectId && !location && !config.cwd)
          throw new Error("The MCP project has no registered workspace. Set an explicit cwd.");
        transport = createMcpTransport(config, location ? workspaceLocationHostPath(location) : undefined);
        const client = new Client(
          { name: "synax-host", version: "0.3.0" },
          { capabilities: {} },
        );
        timer = setTimeout(() => {
          void transport?.close().catch(() => undefined);
        }, START_TIMEOUT_MS);
        await client.connect(transport);
        clearTimeout(timer);
        const listed = await client.listTools();
        const tools = toToolDefs(
          (listed as { tools?: Array<Record<string, unknown>> }).tools ?? [],
        );
        const state: ServerState = {
          status: "ready",
          client,
          transport,
          tools,
        };
        this.servers.set(key, state);
        logger.info(
          { serverId: key, toolCount: tools.length },
          "[mcp] server ready",
        );
        return state;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await transport?.close().catch(() => undefined);
        const state: ServerState = { status: "failed", error: message };
        this.servers.set(key, state);
        logger.warn(
          { serverId: key, err: message },
          "[mcp] server start failed",
        );
        return state;
      } finally {
        clearTimeout(timer);
        this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, promise);
    return promise;
  }

  /** Warm up (start + list tools) for the given server ids. Missing/unconfigured servers are skipped. */
  async warmup(serverIds: string[], projectId?: string): Promise<void> {
    const byId = this.configById(projectId);
    for (const id of serverIds) {
      const config = byId.get(id);
      if (!config || config.enabled === false || !extensionStore.active(projectId, "mcp", id)) continue;
      try {
        await this.startServer(config, projectId);
      } catch {
        /* warm-up best effort */
      }
    }
  }

  getCachedTools(serverId: string, projectId?: string): McpRuntimeToolDef[] {
    const state = this.servers.get(JSON.stringify([projectId ?? null, serverId]));
    return state?.status === "ready" ? state.tools : [];
  }

  async callTool(
    serverId: string,
    toolName: string,
    args: unknown,
    projectId?: string,
  ): Promise<{
    ok: boolean;
    text: string;
    error?: string;
    contentParts?: RuntimeContentPart[];
  }> {
    const byId = this.configById(projectId);
    const config = byId.get(serverId);
    if (!config)
      return { ok: false, text: "", error: `MCP server ${serverId} 未配置` };

    if (config.enabled === false || !extensionStore.active(projectId, "mcp", serverId))
      return { ok: false, text: "", error: `MCP server ${serverId} 已关闭` };

    const state = await this.startServer(config, projectId);
    if (state.status !== "ready") {
      const reason = state.status === "failed" ? state.error : undefined;
      return {
        ok: false,
        text: "",
        error: reason ?? `MCP server ${serverId} 启动失败`,
      };
    }

    const callOnce = async (
      client: Client,
    ): Promise<{
      ok: boolean;
      text: string;
      error?: string;
      contentParts?: RuntimeContentPart[];
    }> => {
      const current = this.configById(projectId).get(serverId);
      if (!current || current.enabled === false || !extensionStore.active(projectId, 'mcp', serverId)) {
        return { ok: false, text: '', error: `MCP server ${serverId} is disabled or removed` };
      }
      const timeout = new Promise<never>((_, reject) => {
        setTimeout(
          () => reject(new Error(`MCP tool ${toolName} 调用超时`)),
          CALL_TIMEOUT_MS,
        );
      });
      const result = (await Promise.race([
        client.callTool({
          name: toolName,
          arguments: (args ?? {}) as Record<string, unknown>,
        }),
        timeout,
      ])) as { content?: unknown; isError?: boolean };
      let contentParts: RuntimeContentPart[] = [];
      try {
        if (!projectId && hasInlineMedia(result.content))
          throw new Error("Media results require a project context.");
        contentParts = projectId
          ? await importToolContent(projectId, result.content)
          : [];
      } catch (error) {
        // The tool already executed. A media import failure must not repeat its side effects.
        return {
          ok: false,
          text: "",
          error: `Tool completed but media could not be retained: ${error instanceof Error ? error.message : String(error)} Do not automatically repeat the tool call.`,
        };
      }
      const text = contentParts.length
        ? contentParts
            .filter((p) => p.type === "text")
            .map((p) => p.text)
            .join("\n")
        : toText(result.content);
      if (result.isError) {
        return {
          ok: false,
          text,
          contentParts,
          error: text || `MCP tool ${toolName} 执行失败`,
        };
      }
      return {
        ok: true,
        text,
        ...(contentParts.some((p) => p.type !== "text")
          ? { contentParts }
          : {}),
      };
    };
    try {
      return await callOnce(state.client);
    } catch (err) {
      // Server may have died between runs — drop the cached state and retry once.
      const message = err instanceof Error ? err.message : String(err);
      const current = this.configById(projectId).get(serverId);
      if (!current || current.enabled === false || !extensionStore.active(projectId, 'mcp', serverId)) return { ok: false, text: '', error: message };
      logger.warn(
        { serverId, toolName, err: message },
        "[mcp] tool call failed; attempting restart",
      );
      this.servers.delete(JSON.stringify([projectId ?? null, serverId]));
      const restarted = await this.startServer(config, projectId);
      if (restarted.status === "ready") {
        try {
          return await callOnce(restarted.client);
        } catch (retryErr) {
          const retryMessage =
            retryErr instanceof Error ? retryErr.message : String(retryErr);
          logger.warn(
            { serverId, toolName, err: retryMessage },
            "[mcp] tool call retry failed",
          );
          return { ok: false, text: "", error: retryMessage };
        }
      }
      return { ok: false, text: "", error: message };
    }
  }

  /** Spawn an ephemeral server, list its tools, then shut it down. Used by "test connection". */
  async probe(
    config: McpServerConfig,
  ): Promise<{ ok: boolean; tools: McpRuntimeToolDef[]; error?: string }> {
    let transport: Transport | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const client = new Client(
      { name: "synax-host-probe", version: "0.3.0" },
      { capabilities: {} },
    );
    try {
      transport = createMcpTransport(config);
      timer = setTimeout(() => {
        void transport?.close().catch(() => undefined);
      }, START_TIMEOUT_MS);
      await client.connect(transport);
      clearTimeout(timer);
      const listed = await client.listTools();
      const tools = toToolDefs(
        (listed as { tools?: Array<Record<string, unknown>> }).tools ?? [],
      );
      await client.close().catch(() => undefined);
      await transport?.close().catch(() => undefined);
      return { ok: true, tools };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await client.close().catch(() => undefined);
      await transport?.close().catch(() => undefined);
      return { ok: false, tools: [], error: message };
    } finally {
      clearTimeout(timer);
    }
  }

  closeServer(serverId: string, projectId?: string): void {
    const key = JSON.stringify([projectId ?? null, serverId]);
    const state = this.servers.get(key);
    this.servers.delete(key);
    if (state?.status === 'ready') {
      void state.client.close().catch(() => undefined);
      void state.transport.close().catch(() => undefined);
    }
    const pending = this.inflight.get(key);
    if (pending) void pending.then(started => {
      if (started.status === 'ready') {
        void started.client.close().catch(() => undefined);
        void started.transport.close().catch(() => undefined);
      }
      if (this.servers.get(key) === started) this.servers.delete(key);
    });
  }

  closeAll(): void {
    for (const [id, state] of this.servers.entries()) {
      if (state.status === "ready") {
        void state.client.close().catch(() => undefined);
        void state.transport.close().catch(() => undefined);
      }
      this.servers.delete(id);
    }
  }
}

export const mcpClientManager = new McpClientManager();
export { sanitizeName };
