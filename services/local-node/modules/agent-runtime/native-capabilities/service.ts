import * as z from "zod/v4";
import type { AgentRuntimeStore } from "../session-store.js";
import type { ProfileService } from "../profile-service.js";
import type { ToolRegistry } from "../tool-registry.js";
import type { RegisteredTool } from "../contracts.js";
import { modelCanUseTool, profileCanUseTool } from "../tool-mount-policy.js";
import { getProjectSettings } from "../../../infrastructure/runtime/config/project-settings-store.js";
import { getGlobalConfigForRuntime } from "../../../infrastructure/runtime/config/config-store.js";
import { canComposeTool, CODE_TOOL_IDS } from "../code-mode/policy.js";
import { createCompositionExecutor, response } from "../code-mode/composition-service.js";
import { CODE_LIMITS } from "../code-mode/contracts.js";
import { CORE_TOOL_IDS, nativeCapabilitiesEnabled } from "./policy.js";
import {
  capabilityContract, disclose, readDisclosure, reconcileDisclosure, DISCLOSURE_LIMITS,
  type CapabilityContract, type CapabilityTool, type DisclosureState,
} from "./disclosure.js";

/** Discovery changes model visibility, never the underlying permissions. */
export class NativeCapabilities {
  constructor(private registry: ToolRegistry, private store: AgentRuntimeStore, private profiles: ProfileService) {}

  private available(sessionId: string): CapabilityTool[] {
    const session = this.store.getSession(sessionId);
    const profile = this.profiles.getForSession(session);
    const webDisabled = getGlobalConfigForRuntime().webSearch.routing === "disabled";
    return this.registry.listForSession(sessionId).filter((tool) =>
      modelCanUseTool(profile, tool) && !CODE_TOOL_IDS.has(tool.id) && !(webDisabled && tool.id === "webSearch"));
  }

  private catalog(sessionId: string, tools = this.available(sessionId)) {
    const session = this.store.getSession(sessionId);
    const config = getProjectSettings(session.projectId).codeMode;
    const profile = this.profiles.getForSession(session);
    const catalog = new Map<string, CapabilityContract>();
    for (const tool of tools) {
      try { catalog.set(tool.id, capabilityContract(tool, profileCanUseTool(profile, tool) && canComposeTool(session, tool, config))); }
      catch { /* One incompatible provider schema must not break the core. */ }
    }
    return catalog;
  }

  private state(sessionId: string, catalog: Map<string, CapabilityContract>): DisclosureState {
    const session = this.store.getSession(sessionId);
    const previous = readDisclosure(session.sessionMetadata?.capabilityDisclosure, sessionId);
    const current = reconcileDisclosure(previous, catalog);
    if (JSON.stringify(previous) !== JSON.stringify(current)) this.save(sessionId, current);
    return current;
  }

  private save(sessionId: string, state: DisclosureState) {
    this.store.updateSessionMetadata(sessionId, { capabilityDisclosure: state });
  }

  /** Called once before each model request, including requests after compaction.
   * Current definitions rehydrate bounded contracts; no stale history is needed. */
  project(sessionId: string, allowed: CapabilityTool[]): { tools: CapabilityTool[]; prompt: string } {
    if (!nativeCapabilitiesEnabled(this.store.getSession(sessionId)))
      return { tools: allowed.filter((tool) => tool.id !== "agent.discover" && tool.id !== "agent.execute"), prompt: "" };
    const business = allowed.filter((tool) => !CODE_TOOL_IDS.has(tool.id));
    const catalog = this.catalog(sessionId, business);
    const state = this.state(sessionId, catalog);
    const disclosed = new Set(state.entries.map((entry) => entry.id));
    const tools = business.filter((tool) => CORE_TOOL_IDS.has(tool.id) || disclosed.has(tool.id));
    const advertised = {
      owner: sessionId,
      contracts: Object.fromEntries(tools.flatMap((tool) => {
        const contract = catalog.get(tool.id);
        return contract ? [[tool.id, contract.version]] : [];
      })),
    };
    if (JSON.stringify(this.store.getSession(sessionId).sessionMetadata?.advertisedCapabilities) !== JSON.stringify(advertised))
      this.store.updateSessionMetadata(sessionId, { advertisedCapabilities: advertised });
    const groups = new Map<string, number>();
    for (const tool of business) groups.set(tool.category, (groups.get(tool.category) ?? 0) + 1);
    const composable = tools.filter((tool) => catalog.get(tool.id)?.compose).map((tool) => tool.id).sort();
    return {
      tools,
      prompt: [
        "## Native capabilities",
        "Only a small working set of tool schemas is exposed. Use agent.discover to search capabilities or load exact IDs. An empty query pages through the directory; hidden tools are not unavailable tools.",
        `Capability groups (counts): ${JSON.stringify(Object.fromEntries([...groups].sort()))}.`,
        tools.some((tool) => tool.id === "agent.execute")
          ? "Use direct calls for simple operations. Use agent.execute for dependent or parallel reads, filtering and aggregation; await tools.call(runtimeToolId, args) and return a small JSON result. Discover unfamiliar contracts before programming. Tool IDs below are runtime IDs, not provider-sanitized names."
          : "Composition is disabled by the current policy. Use direct calls, discovering their schemas as needed.",
        `Currently composable IDs: ${JSON.stringify(composable)}.`,
        "Only currently supplied contracts may be composed. Discovery is effective on the next model step: finish discovery before executing dependent code. Re-discover missing or changed contracts. The dynamic working set is bounded and older contracts may be evicted.",
        "Writes, Shell, browser/computer actions, questions, approvals and workflow changes use direct tools. Discover their schemas as needed. Code cannot suspend for approval, recurse into execution, or replay automatically. After partial failure, inspect the recorded result before choosing the next action.",
      ].join("\n"),
    };
  }

  assertContract(sessionId: string, id: string): void {
    const catalog = this.catalog(sessionId);
    const contract = catalog.get(id);
    const advertised = this.store.getSession(sessionId).sessionMetadata?.advertisedCapabilities as
      { owner?: string; contracts?: Record<string, string> } | undefined;
    if (!contract?.compose || advertised?.owner !== sessionId || advertised.contracts?.[id] !== contract.version)
      throw new Error(`Contract for ${id} is not currently disclosed or composable. Discover it before executing.`);
    this.noteUse(sessionId, id);
  }

  noteUse(sessionId: string, id: string): void {
    if (CORE_TOOL_IDS.has(id)) return;
    const session = this.store.getSession(sessionId);
    const state = readDisclosure(session.sessionMetadata?.capabilityDisclosure, sessionId);
    const entry = state.entries.find((item) => item.id === id);
    if (entry) {
      entry.usedAt = Date.now();
      this.save(sessionId, state);
    }
  }

  tools(): RegisteredTool[] {
    return [{
      id: "agent.discover", label: "Discover capabilities", category: "read", mutability: "read", resumeBehavior: "none",
      description: "Native capability discovery. Search with query/group or load up to four exact runtime IDs. Omit filters to browse all capabilities; cursor pages results. Returns bounded contracts and exposes their direct tool schemas on the NEXT step. Discovery is not authorization. Do not execute dependent code in the same step.",
      inputSchema: z.object({
        query: z.string().max(120).optional(), group: z.string().max(256).optional(),
        ids: z.array(z.string().min(1).max(256)).min(1).max(4).optional(),
        cursor: z.number().int().min(0).max(100000).optional(),
      }).strict(),
      execute: (input) => {
        if (!nativeCapabilitiesEnabled(this.store.getSession(input.sessionId))) return response({ status: "denied" }, "Native capability discovery is disabled.");
        const args = input.args as { query?: string; group?: string; ids?: string[]; cursor?: number };
        const available = this.available(input.sessionId).sort((a, b) => a.id.localeCompare(b.id));
        const catalog = this.catalog(input.sessionId, available);
        const query = args.query?.toLowerCase();
        const matching = available.filter((tool) => (!args.ids || args.ids.includes(tool.id)) &&
          (!args.group || tool.category === args.group || catalog.get(tool.id)?.group === args.group) &&
          (!query || `${tool.id} ${tool.label} ${tool.description}`.toLowerCase().includes(query)));
        const offset = args.cursor ?? 0;
        const page = matching.slice(offset, offset + DISCLOSURE_LIMITS.page);
        let tokens = 0;
        const selected: CapabilityContract[] = [];
        const unavailable: Array<{ id: string; reason: string }> = [];
        for (const tool of page) {
          const contract = catalog.get(tool.id);
          if (!contract || tokens + contract.tokens > DISCLOSURE_LIMITS.tokens) {
            unavailable.push({ id: tool.id, reason: contract ? "Contract exceeds remaining page budget; request this ID separately." : "Schema cannot be serialized." });
            continue;
          }
          tokens += contract.tokens;
          selected.push(contract);
        }
        const state = disclose(this.state(input.sessionId, catalog), selected, catalog);
        this.save(input.sessionId, state);
        return response({
          contracts: selected.map(({ tokens: _tokens, ...contract }) => contract),
          unavailable,
          missing: args.ids?.filter((id) => !matching.some((tool) => tool.id === id)),
          total: matching.length,
          nextCursor: offset + page.length < matching.length ? offset + page.length : null,
          active: state.entries.map((entry) => entry.id),
          nextAction: "Contracts and direct schemas are available on the next model step.",
        }, `Discovered ${selected.length} capability contracts.`);
      },
    }, {
      id: "agent.execute", label: "Native read composition", category: "read", mutability: "read", resumeBehavior: "none",
      description: "Native execution channel for read-only JavaScript composition. Submit an async function body using await tools.call(runtimeToolId,args), then return a compact JSON result. Use currently supplied contracts; discover others first. Up to 4 parallel calls, 32 total calls and 15 seconds. No imports, Node, direct filesystem/network, writes, Shell or nested execution. Await all calls. Failure never automatically replays code or asks for approval.",
      inputSchema: z.object({ code: z.string().min(1).max(CODE_LIMITS.maxCodeBytes) }).strict(),
      execute: createCompositionExecutor(this.registry, this.store, this.profiles, (sessionId, id) => this.assertContract(sessionId, id)),
    }];
  }
}
