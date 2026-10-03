import * as z from 'zod/v4';
import { extensionStore } from './extension-store.js';
import { agentRuntimeStore } from '../agent-runtime/session-store.js';
import { runCommand } from '../agent-runtime/tools/exec-async.js';
import {
  resolveWorkspacePath,
  workspaceRoot,
} from '../agent-runtime/tools/workspace.js';
import type {
  RegisteredTool,
  SessionToolProvider,
} from '../agent-runtime/contracts.js';
import type { ExtensionDefinition } from './types.js';

export function buildCustomTool(
  definition: ExtensionDefinition,
  projectId: string,
): RegisteredTool {
  const config = definition.tool!;
  return {
    id: definition.id,
    label: definition.name,
    description: definition.description,
    category: config.mode === 'command' ? 'shell' : 'mcp',
    internalGate: config.mode === 'command' ? 'shell' : 'network',
    mutability: 'write',
    resumeBehavior: 'wait_permission',
    inputSchema: z.fromJSONSchema(config.inputSchema),
    getPattern: () =>
      config.mode === 'command'
        ? [config.command, ...(config.args ?? [])].join(' ')
        : config.url,
    execute: async (input) => {
      if (!extensionStore.active(projectId, 'tool', definition.id))
        throw new Error('This tool has been removed or disabled');
      input.abortSignal?.throwIfAborted();
      if (config.mode === 'command') {
        const cwd = config.cwd
          ? resolveWorkspacePath(config.cwd, input.sessionId)
          : workspaceRoot(input.sessionId);
        const result = await runCommand(config.command!, config.args ?? [], {
          cwd,
          stdin: JSON.stringify(input.args ?? {}),
          timeoutMs: config.timeoutMs ?? 30000,
          maxBufferBytes: 64 * 1024,
          signal: input.abortSignal,
        });
        const summary = result.timedOut
          ? 'Tool timed out'
          : (result.error?.message ??
            (result.stdout || result.stderr || `Exit ${result.status}`));
        return {
          result: {
            ok: result.status === 0 && !result.timedOut && !result.error,
            stdout: result.stdout,
            stderr: result.stderr,
            exitCode: result.status,
            truncated: result.stdoutTruncated || result.stderrTruncated,
          },
          displaySummary: summary.slice(0, 1200),
          artifacts: [],
        };
      }
      // Fixed user-configured URL; arguments are data, never interpolated into executable code or URLs.
      // Unlike a remote catalog download, this endpoint is explicitly configured
      // by the user and guarded by the MCP/network permission flow. Local and
      // intranet APIs are valid tool endpoints; redirects remain disallowed.
      const endpoint = new URL(config.url!);
      if (
        !['http:', 'https:'].includes(endpoint.protocol) ||
        endpoint.username ||
        endpoint.password
      )
        throw new Error('Invalid HTTP tool endpoint');
      const signal = AbortSignal.any([
        AbortSignal.timeout(config.timeoutMs ?? 30000),
        ...(input.abortSignal ? [input.abortSignal] : []),
      ]);
      const response = await fetch(config.url!, {
        method: 'POST',
        headers: { ...config.headers, 'Content-Type': 'application/json' },
        body: JSON.stringify(input.args ?? {}),
        redirect: 'error',
        signal,
      });
      const reader = response.body?.getReader();
      let text = '';
      let size = 0;
      const decoder = new TextDecoder();
      if (reader) {
        try {
          for (;;) {
            const chunk = await reader.read();
            if (chunk.done) break;
            size += chunk.value.byteLength;
            if (size > 64 * 1024)
              throw new Error('HTTP tool response exceeds 64 KB');
            text += decoder.decode(chunk.value, { stream: true });
          }
          text += decoder.decode();
        } finally {
          await reader.cancel().catch(() => {});
        }
      }
      return {
        result: { ok: response.ok, status: response.status, text },
        displaySummary: text.slice(0, 1200) || `HTTP ${response.status}`,
        artifacts: [],
      };
    },
  };
}
export const customToolProvider: SessionToolProvider = {
  id: 'synax-custom-tools',
  getTools(sessionId) {
    const session = agentRuntimeStore.tryGetSession(sessionId);
    if (!session) return [];
    return extensionStore
      .definitions(session.projectId, 'tool')
      .filter(
        (definition) =>
          definition.tool &&
          extensionStore.active(session.projectId, 'tool', definition.id),
      )
      .map((definition) => buildCustomTool(definition, session.projectId));
  },
  getHooks: () => [],
};
