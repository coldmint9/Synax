import path from 'node:path';
import * as z from 'zod/v4';
import type { McpServerConfig } from '../runtime/config/config-types.js';

export const CUA_SERVER_ID = 'builtin-cua-driver';
const connectionSchema = z.object({
  generation: z.string().min(1).max(128),
  command: z.string().min(1).max(4096).refine(path.isAbsolute),
  args: z.array(z.string().max(4096)).max(32),
  environment: z.array(z.object({ name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), value: z.string().max(8192) })).max(64),
});
export type RuntimeCuaConnection = z.infer<typeof connectionSchema>;
let connection: RuntimeCuaConnection | null = null;

/** Only the Electron parent IPC channel can install this ephemeral configuration. */
export function setRuntimeCuaConnection(value: unknown): boolean {
  if (value === null) {
    const changed = connection !== null;
    connection = null;
    return changed;
  }
  const next = connectionSchema.parse(value);
  if (connection?.generation === next.generation) return false;
  connection = next;
  return true;
}
export function getRuntimeCuaConnection(): RuntimeCuaConnection | null { return connection; }
export function getRuntimeCuaConfig(): McpServerConfig | null {
  if (!connection) return null;
  return {
    id: CUA_SERVER_ID,
    name: 'Cua Driver',
    command: connection.command,
    args: connection.args,
    env: Object.fromEntries(connection.environment.map(({ name, value }) => [name, value])),
    enabled: true,
  };
}
