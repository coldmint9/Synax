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
import { capabilityDirectory, capabilityGroup, searchCapabilities } from "./search.js";
import {
  capabilityContract, disclose, readDisclosure, reconcileDisclosure, DISCLOSURE_LIMITS,
  type CapabilityContract, type CapabilityTool, type DisclosureState,
} from "./disclosure.js";

/** Discovery changes model visibility, never the underlying permissions. */
export class NativeCapabilities {
  private readonly catalogCache = new Map<string, { signature: string; catalog: Map<string, CapabilityContract> }>();

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
    // The registry can be rebuilt after an MCP reconnect, so key this cache by
    // the contract versions and effective compose grants rather than by the
    // session alone. This keeps repeated loop projections cheap without
    // allowing stale or newly unauthorized contracts to survive.
    const signature = [...catalog.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([id, contract]) => `${id}:${contract.version}:${contract.compose ? "1" : "0"}`)
      .join("|");
    const cached = this.catalogCache.get(sessionId);
    if (cached?.signature === signature) return cached.catalog;
    this.catalogCache.set(sessionId, { signature, catalog });
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
    const current = readDisclosure(this.store.getSession(sessionId).sessionMetadata?.capabilityDisclosure, sessionId);
    if (JSON.stringify(current) === JSON.stringify(state)) return;
    this.store.updateSessionMetadata(sessionId, { capabilityDisclosure: state });
  }

  /** Called once before each model request, including requests after compaction.
   * Current definitions rehydrate session discoveries; no stale history is needed. */
  project(sessionId: string, allowed: CapabilityTool[]): { tools: CapabilityTool[]; prompt: string } {
    if (!nativeCapabilitiesEnabled(this.store.getSession(sessionId)))
      return { tools: allowed.filter((tool) => !["agent.discover", "agent.execute"].includes(tool.id)), prompt: "" };
    const business = allowed.filter((tool) => !CODE_TOOL_IDS.has(tool.id));
    const catalog = this.catalog(sessionId, business);
    const state = this.state(sessionId, catalog);
    const disclosed = new Set(state.entries.map((entry) => entry.id));
    const tools = business
      .filter((tool) => CORE_TOOL_IDS.has(tool.id) || disclosed.has(tool.id))
      .toSorted((a, b) => a.id.localeCompare(b.id));
    const advertised = {
      owner: sessionId,
        contracts: Object.fromEntries(tools.flatMap((tool) => {
        const contract = catalog.get(tool.id);
        return contract ? [[tool.id, contract.version]] : [];
      })),
    };
    if (JSON.stringify(this.store.getSession(sessionId).sessionMetadata?.advertisedCapabilities) !== JSON.stringify(advertised))
      this.store.updateSessionMetadata(sessionId, { advertisedCapabilities: advertised });
    const directory = capabilityDirectory(business.filter((tool) => !CORE_TOOL_IDS.has(tool.id)));
    const composable = tools.filter((tool) => catalog.get(tool.id)?.compose).map((tool) => tool.id).sort();
    return {
      tools,
      prompt: [
        "## Native capabilities",
        "Core tools and all capabilities discovered in this session are exposed. Use agent.discover only for capabilities missing from the current tool list. An empty query pages through the directory; hidden tools are not unavailable tools.",
        "Discovered capabilities stay loaded across turns and context compaction in this session while available and permitted; updated definitions are refreshed automatically. Call exposed tools directly. Do not search again to confirm availability or reload a known tool.",
        `Deferred capability directory (group, count, example IDs and labels): ${JSON.stringify(directory.slice(0, 24))}.`,
        "Use mode:list to browse compact tool summaries without loading schemas; use query keywords to search by purpose or MCP server name; use ids to load exact runtime IDs. Exact IDs override query/group. Search uses ranked terms, not an exact phrase. If no match, inspect returned groups and browse instead of repeating the same query.",
        ...(directory.length > 24 ? ["More groups exist; mode:list with cursor browses all tools."] : []),
        "Use agent.execute (Code Mode) when several tool reads or intermediate results can be filtered, joined or aggregated before returning to you. Submit a JavaScript async function body: await tools.call(runtimeToolId, args), process the returned JSON, then return only the selected evidence or compact result needed for your answer. Intermediate tool results and console logs remain in the audit journal, outside model context. Include source paths or record IDs in your return value when needed to support conclusions. Use direct tools for simple operations whose full output you need.",
        `Sandbox-composable IDs: ${JSON.stringify(composable)}.`,
        "Inside agent.execute, later calls can use earlier results without another model turn. Example: const a = await tools.call('file.read', {path: 'data.json'}); const rows = JSON.parse(a.content); return {count: rows.length, flagged: rows.filter(r => r.flagged).map(r => r.id)}; Only use known result shapes. Await all calls. Programs are stateless, bounded, and never automatically replayed. For approval use direct tools; after a program failure inspect its audit receipts before retrying writes. Ordinary direct operations still use the loop's ordered scheduling and approval/resume lifecycle.",
        "Discover missing contracts first; disclosure takes effect on the next model step. Shell, browser and workflow controls use their host lifecycle within the same ordered program. Existing permissions and file-change checks still apply.",
      ].join("\n"),
    };
  }

  assertContract(sessionId: string, id: string): void {
    const catalog = this.catalog(sessionId);
    const contract = catalog.get(id);
    const advertised = this.store.getSession(sessionId).sessionMetadata?.advertisedCapabilities as
      { owner?: string; contracts?: Record<string, string> } | undefined;
    if (!contract || (!CORE_TOOL_IDS.has(id) && (!contract.compose || advertised?.owner !== sessionId || advertised.contracts?.[id] !== contract.version)))
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
      description: "Find missing capabilities by purpose, tool name or MCP server name. query uses ranked keywords. mode:list returns compact summaries without loading; cursor pages results. ids loads up to four exact runtime IDs and overrides query/group/cursor. With no filters, returns the directory. Search/load exposes tools on the NEXT step and keeps them loaded across turns and compaction. Call exposed tools directly. For skills, use the available-skills catalog and skill.load with its exact skillId. Discovery is not authorization.",
      inputSchema: z.object({
        mode: z.enum(["search", "list"]).optional(),
        query: z.string().max(120).optional(), group: z.string().max(256).optional(),
        ids: z.array(z.string().min(1).max(256)).max(4).optional().describe("Exact runtime IDs to load; use [] or omit for keyword search or browsing."),
        cursor: z.number().int().min(0).max(100000).optional(),
      }).strict(),
      execute: (input) => {
        if (!nativeCapabilitiesEnabled(this.store.getSession(input.sessionId))) return response({ status: "denied" }, "Native capability discovery is disabled.");
        const args = input.args as { mode?: "search" | "list"; query?: string; group?: string; ids?: string[]; cursor?: number };
        const available = this.available(input.sessionId).sort((a, b) => a.id.localeCompare(b.id));
        const catalog = this.catalog(input.sessionId, available);
        const matching = searchCapabilities(available, args.query?.trim(), args.group?.trim(), args.ids);
        const listing = !args.ids?.length && (args.mode === "list" || (!args.mode && !args.query?.trim() && !args.group?.trim()));
        const offset = args.ids?.length ? 0 : args.cursor ?? 0;
        const page = matching.slice(offset, offset + (listing ? 20 : DISCLOSURE_LIMITS.page));
        const selected: CapabilityContract[] = [];
        const unavailable: Array<{ id: string; reason: string }> = [];
        for (const tool of page) {
          if (listing) continue;
          const contract = catalog.get(tool.id);
          if (!contract) {
            unavailable.push({ id: tool.id, reason: "Schema cannot be serialized." });
            continue;
          }
          selected.push(contract);
        }
        const state = disclose(this.state(input.sessionId, catalog), selected, catalog);
        this.save(input.sessionId, state);
        return response({
          mode: listing ? "list" : "search",
          results: page.map((tool) => ({ id: tool.id, label: tool.label, description: tool.description.slice(0, 240), group: capabilityGroup(tool), loaded: CORE_TOOL_IDS.has(tool.id) || state.entries.some((entry) => entry.id === tool.id) })),
          ...((listing || matching.length === 0) ? { groups: capabilityDirectory(available).map(({ group, count }) => ({ group, count })) } : {}),
          contracts: selected.map(({ tokens: _tokens, ...contract }) => contract),
          unavailable,
          missing: args.ids?.filter((id) => !matching.some((tool) => tool.id === id)),
          total: matching.length,
          nextCursor: offset + page.length < matching.length ? offset + page.length : null,
          active: state.entries.map((entry) => entry.id),
          nextAction: listing
            ? "Choose an unloaded result and load its exact id with ids. Loaded results are already callable; do not load them again. Use nextCursor to browse more summaries."
            : selected.length
              ? "Call the discovered tools directly from the next model step. They remain loaded in this session; no repeat discovery is needed while available and permitted."
              : "No callable match. Check missing/unavailable and returned groups; use mode:list to browse or try fewer keywords. Do not repeat the same search. Skills are in the available-skills catalog, loaded via skill.load.",
        }, listing ? `Listed ${page.length} capabilities without loading.` : `Discovered ${selected.length} capability contracts.`);
      },
    }, {
      id: "agent.execute", label: "Code Mode", category: "read", mutability: "read", resumeBehavior: "none",
      description: "Run an isolated JavaScript async function body to call tools and filter, join or aggregate intermediate results. Use await tools.call(runtimeToolId,args), process the JSON results locally, then return only selected evidence or a compact JSON answer. Only your return value and execution status enter model context; intermediate results and console logs stay in the audit journal. Supports approved reads, file.write and file.patch with their existing permissions. Use currently supplied composable contracts; discover others first. Up to 32 calls and 15 seconds; await all calls (calls are ordered). No imports, Node, direct filesystem/network, Shell or nested execution. Stateless; failure never automatically replays code or asks for approval. Use direct tools when approval is needed.",
      inputSchema: z.object({ code: z.string().min(1).max(CODE_LIMITS.maxCodeBytes) }).strict(),
      execute: createCompositionExecutor(this.registry, this.store, this.profiles, (sessionId, id) => this.assertContract(sessionId, id)),
    }];
  }
}
