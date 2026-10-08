import {
  hasInlineMedia,
  importToolContent,
} from "../../modules/agent-runtime/media-tool-content.js";
import type { RuntimeContentPart } from "../../modules/agent-runtime/content-parts.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createMcpTransport } from "./mcp-transport.js";
import { extensionStore } from "../../modules/extensions/extension-store.js";
import { CUA_SERVER_ID, getRuntimeCuaConfig } from "./runtime-cua-config.js";

import { readWorkspaceProject, projectSourceLocation } from "../../modules/project-workspace.js";
import { workspaceLocationHostPath } from "../../modules/workspace-location.js";
import type { McpServerConfig } from "../runtime/config/config-types.js";
import { getGlobalConfigForRuntime } from "../runtime/config/config-store.js";
import { getProjectSettings } from "../runtime/config/project-settings-store.js";
import { logger } from "../runtime/logger.js";

export interface McpRuntimeToolDef {
  name: string;
  title?: string;
  description?: string;
  readOnlyHint?: boolean;
  inputSchema?: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
}

const START_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 60_000;

type ServerState =
  | { status: "idle" }
  | { status: "starting"; transport?: Transport }
  | {
      status: "ready";
      client: Client;
      transport: Transport;
      tools: McpRuntimeToolDef[];
      lastUsed: number;
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
      readOnlyHint: (tool.annotations as Record<string, unknown> | undefined)?.readOnlyHint === true,
      inputSchema: tool.inputSchema && typeof tool.inputSchema === "object" ? tool.inputSchema as Record<string, unknown> : undefined,
      outputSchema: tool.outputSchema && typeof tool.outputSchema === "object" ? tool.outputSchema as Record<string, unknown> : undefined,
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
  private cuaQueue: Promise<void> = Promise.resolve();
  private cuaSweep: ReturnType<typeof setInterval> | null = null;

  /** Serialize access to the shared physical desktop without blocking Node's event loop. */
  private async withCuaTurn<T>(action: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    const previous = this.cuaQueue;
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    this.cuaQueue = previous.then(() => current);
    try {
      if (signal) {
        signal.throwIfAborted();
        let onAbort: (() => void) | undefined;
        try {
          const aborted = new Promise<never>((_, reject) => {
            onAbort = () => reject(signal.reason ?? new Error('Cua operation cancelled'));
            signal.addEventListener('abort', onAbort, { once: true });
          });
          await Promise.race([previous, aborted]);
        } finally { if (onAbort) signal.removeEventListener('abort', onAbort); }
        signal.throwIfAborted();
      } else await previous;
      return await action();
    } finally { release(); }
  }

  private startCuaSweep(): void {
    if (this.cuaSweep) return;
    this.cuaSweep = setInterval(() => {
      const now = Date.now();
      for (const [key, state] of this.servers) {
        const [projectId, serverId, sessionId] = JSON.parse(key) as [string | null, string, string | null];
        if (serverId === CUA_SERVER_ID && state.status === 'ready' && now - state.lastUsed > 10 * 60_000)
          this.closeServer(serverId, projectId ?? undefined, sessionId ?? undefined);
      }
    }, 60_000);
    this.cuaSweep.unref?.();
  }

  private key(serverId: string, projectId?: string, sessionId?: string): string {
    return JSON.stringify([projectId ?? null, serverId, serverId === CUA_SERVER_ID ? sessionId ?? null : null]);
  }

  private configById(projectId?: string): Map<string, McpServerConfig> {
    // MCP is project-scoped. Keep the global list only for backward-compatible
    // probe/config reads; never make global servers available to Agent runs.
    if (projectId) {
      const cua = getRuntimeCuaConfig();
      const project = getProjectSettings(projectId, true);
      return new Map([
        ...(project.mcpServers ?? []).map((server) => [server.id, server] as const),
        ...(cua ? [[CUA_SERVER_ID, cua] as const] : []),
      ]);
    }
    const config = getGlobalConfigForRuntime();
    return new Map(
      (config?.mcpServers ?? []).map((server) => [server.id, server]),
    );
  }

  private async startServer(config: McpServerConfig, projectId?: string, sessionId?: string): Promise<ServerState> {
    const key = this.key(config.id, projectId, sessionId);
    const existing = this.servers.get(key);
    if (existing?.status === "ready") { existing.lastUsed = Date.now(); return existing; }
    const pending = this.inflight.get(key);
    if (pending) return pending;

    // The marker owns this startup. Closing or replacing it invalidates the
    // result, even when connect/listTools finishes after a new startup began.
    const starting: ServerState & { status: "starting" } = { status: "starting" };
    this.servers.set(key, starting);

    let promise!: Promise<ServerState>;
    promise = (async (): Promise<ServerState> => {
      let transport: Transport | undefined;
      let client: Client | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const project = projectId ? readWorkspaceProject(projectId) : undefined;
        const location = project ? projectSourceLocation(project) : undefined;
        if (config.id !== CUA_SERVER_ID && config.transport !== "http" && projectId && !location && !config.cwd)
          throw new Error("The MCP project has no registered workspace. Set an explicit cwd.");
        transport = createMcpTransport(config, config.id === CUA_SERVER_ID ? undefined : location ? workspaceLocationHostPath(location) : undefined);
        starting.transport = transport;
        client = new Client(
          { name: "synax-host", version: "1.11.1" },
          { capabilities: {} },
        );
        timer = setTimeout(() => {
          void transport?.close().catch(() => undefined);
        }, START_TIMEOUT_MS);
        await client.connect(transport);
        // Drain piped diagnostics so a noisy helper cannot block on stderr.
        if ('stderr' in transport) {
          (transport.stderr as { resume?: () => void } | null)?.resume?.();
        }
        const listed = await client.listTools();
        const tools = toToolDefs(
          (listed as { tools?: Array<Record<string, unknown>> }).tools ?? [],
        );
        const state: ServerState = {
          status: "ready",
          client,
          transport,
          tools,
          lastUsed: Date.now(),
        };
        if (this.servers.get(key) !== starting) {
          await client.close().catch(() => undefined);
          await transport.close().catch(() => undefined);
          return { status: "failed", error: "MCP server closed during startup" };
        }
        this.servers.set(key, state);
        if (config.id === CUA_SERVER_ID) this.startCuaSweep();
        logger.info(
          { serverId: key, toolCount: tools.length },
          "[mcp] server ready",
        );
        return state;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await client?.close().catch(() => undefined);
        await transport?.close().catch(() => undefined);
        const state: ServerState = { status: "failed", error: message };
        if (this.servers.get(key) === starting) this.servers.set(key, state);
        logger.warn(
          { serverId: key, err: message },
          "[mcp] server start failed",
        );
        return state;
      } finally {
        clearTimeout(timer);
        // A close may have allowed a newer startup to take this key.
        if (this.inflight.get(key) === promise) this.inflight.delete(key);
      }
    })();

    this.inflight.set(key, promise);
    return promise;
  }

  /** Warm up (start + list tools) for the given server ids. Missing/unconfigured servers are skipped. */
  async warmup(serverIds: string[], projectId?: string, sessionId?: string): Promise<void> {
    const byId = this.configById(projectId);
    for (const id of serverIds) {
      const config = byId.get(id);
      if (!config || config.enabled === false || (id !== CUA_SERVER_ID && !extensionStore.active(projectId, "mcp", id))) continue;
      try {
        await this.startServer(config, projectId, sessionId);
      } catch {
        /* warm-up best effort */
      }
    }
  }

  getCachedTools(serverId: string, projectId?: string, sessionId?: string): McpRuntimeToolDef[] {
    const state = this.servers.get(this.key(serverId, projectId, sessionId));
    return state?.status === "ready" ? state.tools : [];
  }

  async callTool(
    serverId: string,
    toolName: string,
    args: unknown,
    projectId?: string,
    sessionId?: string,
    abortSignal?: AbortSignal,
  ): Promise<{
    ok: boolean;
    text: string;
    error?: string;
    contentParts?: RuntimeContentPart[];
    structuredContent?: unknown;
  }> {
    const byId = this.configById(projectId);
    const config = byId.get(serverId);
    if (!config)
      return { ok: false, text: "", error: `MCP server ${serverId} 未配置` };

    if (config.enabled === false || (serverId !== CUA_SERVER_ID && !extensionStore.active(projectId, "mcp", serverId)))
      return { ok: false, text: "", error: `MCP server ${serverId} 已关闭` };

    const state = await this.startServer(config, projectId, sessionId);
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
      structuredContent?: unknown;
    }> => {
      const current = this.configById(projectId).get(serverId);
      if (!current || current.enabled === false || (serverId !== CUA_SERVER_ID && !extensionStore.active(projectId, 'mcp', serverId))) {
        return { ok: false, text: '', error: `MCP server ${serverId} is disabled or removed` };
      }
      abortSignal?.throwIfAborted();
      const result = (await client.callTool(
        { name: toolName, arguments: (args ?? {}) as Record<string, unknown> },
        undefined,
        { timeout: CALL_TIMEOUT_MS, signal: abortSignal },
      )) as { content?: unknown; isError?: boolean; structuredContent?: unknown };
      abortSignal?.throwIfAborted();
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
          structuredContent: result.structuredContent,
          error: text || `MCP tool ${toolName} 执行失败`,
        };
      }
      return {
        ok: true,
        text,
        structuredContent: result.structuredContent,
        ...(contentParts.some((p) => p.type !== "text")
          ? { contentParts }
          : {}),
      };
    };
    try {
      return await (serverId === CUA_SERVER_ID ? this.withCuaTurn(() => callOnce(state.client), abortSignal) : callOnce(state.client));
    } catch (err) {
      // Server may have died between runs — drop the cached state and retry once.
      const message = err instanceof Error ? err.message : String(err);
      const current = this.configById(projectId).get(serverId);
      if (!current || current.enabled === false || (serverId !== CUA_SERVER_ID && !extensionStore.active(projectId, 'mcp', serverId))) return { ok: false, text: '', error: message };
      logger.warn(
        { serverId, toolName, err: message },
        serverId === CUA_SERVER_ID ? '[cua] operation outcome unknown' : '[mcp] tool call failed; attempting restart',
      );
      // Desktop actions have unknown outcomes if the transport drops after dispatch.
      // Never replay a Cua action (including a supposedly read-only observation).
      if (serverId === CUA_SERVER_ID || abortSignal?.aborted) {
        this.closeServer(serverId, projectId, sessionId);
        return { ok: false, text: "", error: `Cua operation outcome unknown: ${message}. Reobserve before any further action; do not repeat it automatically.` };
      }
      this.closeServer(serverId, projectId, sessionId);
      const restarted = await this.startServer(config, projectId, sessionId);
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
      { name: "synax-host-probe", version: "1.11.1" },
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

  closeServer(serverId: string, projectId?: string, sessionId?: string): void {
    const key = this.key(serverId, projectId, sessionId);
    const state = this.servers.get(key);
    this.servers.delete(key);
    this.inflight.delete(key);
    if (state?.status === 'starting') {
      void state.transport?.close().catch(() => undefined);
    }
    if (state?.status === 'ready') {
      void state.client.close().catch(() => undefined);
      void state.transport.close().catch(() => undefined);
    }
  }

  closeCua(): void {
    for (const key of [...this.servers.keys()]) {
      const [projectId, serverId, sessionId] = JSON.parse(key) as [string | null, string, string | null];
      if (serverId === CUA_SERVER_ID) this.closeServer(CUA_SERVER_ID, projectId ?? undefined, sessionId ?? undefined);
    }
  }

  closeAll(): void {
    if (this.cuaSweep) { clearInterval(this.cuaSweep); this.cuaSweep = null; }
    for (const key of [...this.servers.keys()]) {
      const [projectId, serverId, sessionId] = JSON.parse(key) as [string | null, string, string | null];
      this.closeServer(serverId, projectId ?? undefined, sessionId ?? undefined);
    }
  }
}

export const mcpClientManager = new McpClientManager();
export { sanitizeName };
