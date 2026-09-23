import type { McpServerConfig } from '../../lib/config/config-types.js';

export type ExtensionKind = 'tool' | 'skill' | 'mcp';
export interface ExtensionState {
  installed: boolean;
  enabled: boolean;
}
export interface CustomToolConfig {
  mode: 'command' | 'http';
  command?: string;
  args?: string[];
  url?: string;
  headers?: Record<string, string>;
  cwd?: string;
  inputSchema: Record<string, unknown>;
  timeoutMs?: number;
}
export interface ExtensionDefinition {
  id: string;
  kind: ExtensionKind;
  name: string;
  description: string;
  version?: string;
  sourceId: string;
  tool?: CustomToolConfig;
  skillPath?: string;
  mcp?: McpServerConfig;
}
export interface ExtensionItem extends ExtensionState {
  id: string;
  kind: ExtensionKind;
  name: string;
  description: string;
  sourceId: string;
  sourceLabel: string;
  version?: string;
  editable?: boolean;
  permissions?: string[];
  detail?: string;
  /** An opaque local-discovery id or a remote catalog locator, not a filesystem path. */
  locator?: {
    sourceId: string;
    name: string;
    remoteUrl?: string;
    discoveryId?: string;
  };
  conflict?: string;
}
export interface ExtensionSource {
  id: string;
  name: string;
  description: string;
  kind: 'builtin' | 'local' | 'custom' | 'remote';
  editable?: boolean;
}
export interface ExtensionList {
  items: ExtensionItem[];
  total: number;
  totalExact?: boolean;
  hasMore: boolean;
  warnings: string[];
}
export interface CustomExtensionInput {
  id?: string;
  kind: ExtensionKind;
  name: string;
  description: string;
  tool?: CustomToolConfig;
  content?: string;
  mcp?: McpServerConfig;
}
