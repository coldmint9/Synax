import { createHash } from "node:crypto";
import * as z from "zod/v4";
import type { RegisteredTool } from "../contracts.js";
import { countTokens } from "../context-tokenizer.js";
import { CORE_TOOL_IDS } from "./policy.js";

export type CapabilityTool = Omit<RegisteredTool, "execute">;
export interface CapabilityContract {
  id: string;
  description: string;
  inputSchema: Record<string, unknown>;
  version: string;
  compose: boolean;
  group: string;
  tokens: number;
}
export interface DisclosureEntry { id: string; version: string; usedAt: number }
export interface DisclosureState { version: 1; owner: string; entries: DisclosureEntry[] }
export const DISCLOSURE_LIMITS = { count: 12, tokens: 8000, page: 4 } as const;

// Weak references avoid keeping disconnected MCP tools alive indefinitely.
const contracts = new WeakMap<object, { signature: string; contract: Omit<CapabilityContract, "compose"> }>();
export function capabilityContract(tool: CapabilityTool, compose: boolean): CapabilityContract {
  const key = tool.inputSchema ?? tool;
  const signature = JSON.stringify([tool.id, tool.description, tool.progressiveDetails, tool.category]);
  const cached = contracts.get(key);
  if (cached?.signature === signature) return { ...cached.contract, compose };
  const inputSchema = tool.inputSchema
    ? z.toJSONSchema(tool.inputSchema, { unrepresentable: "any" })
    : { type: "object" };
  const description = [tool.description, tool.progressiveDetails].filter(Boolean).join(" ");
  const serialized = JSON.stringify({ id: tool.id, description, inputSchema });
  const contract = {
    id: tool.id, description, inputSchema,
    group: tool.category === "mcp" ? `mcp.${tool.id.split(".")[1]}` : tool.category,
    version: createHash("sha256").update(serialized).digest("hex").slice(0, 20),
    tokens: countTokens(serialized),
  };
  contracts.set(key, { signature, contract });
  return { ...contract, compose };
}

export function readDisclosure(value: unknown, owner: string): DisclosureState {
  const state = value as Partial<DisclosureState> | undefined;
  // An inherited metadata object must never disclose a parent's contracts.
  if (state?.version !== 1 || state.owner !== owner || !Array.isArray(state.entries))
    return { version: 1, owner, entries: [] };
  return {
    version: 1, owner,
    entries: state.entries.filter((entry) => entry && typeof entry.id === "string" &&
      typeof entry.version === "string" && Number.isFinite(entry.usedAt)).slice(0, DISCLOSURE_LIMITS.count),
  };
}

export function reconcileDisclosure(state: DisclosureState, catalog: Map<string, CapabilityContract>): DisclosureState {
  let tokens = 0;
  const entries = [...state.entries].sort((a, b) => b.usedAt - a.usedAt).filter((entry) => {
    const contract = catalog.get(entry.id);
    if (!contract || contract.version !== entry.version || CORE_TOOL_IDS.has(entry.id)) return false;
    if (tokens + contract.tokens > DISCLOSURE_LIMITS.tokens) return false;
    tokens += contract.tokens;
    return true;
  }).slice(0, DISCLOSURE_LIMITS.count);
  return { ...state, entries };
}

export function disclose(state: DisclosureState, selected: CapabilityContract[], catalog: Map<string, CapabilityContract>): DisclosureState {
  const additions = selected.filter((item) => !CORE_TOOL_IDS.has(item.id));
  const ids = new Set(additions.map((item) => item.id));
  const usedAt = Math.max(Date.now(), ...state.entries.map((item) => item.usedAt + 1));
  return reconcileDisclosure({ ...state, entries: [
    ...additions.map(({ id, version }) => ({ id, version, usedAt })),
    ...state.entries.filter((item) => !ids.has(item.id)),
  ] }, catalog);
}
