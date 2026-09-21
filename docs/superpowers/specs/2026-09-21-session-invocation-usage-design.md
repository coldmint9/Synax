# Session Invocation Usage Design

**Date:** 2026-09-21  
**Status:** Approved for specification review

## Summary

Replace the runtime-details capability inventory with a session invocation usage panel. The panel must show only capabilities actually invoked by the selected session and display only each capability object's name and cumulative call count.

Tools, skills, and MCP servers are represented by one normalized usage model. The panel no longer lists all mounted tools, candidate skills, or configured MCP servers, and it no longer displays availability locks or `visible/available` counts such as `0/42`.

## Goals

- Show what the selected session actually invoked, rather than what it could invoke.
- Present Tool, Skill, and MCP usage through one common data model.
- Aggregate MCP calls by MCP server, not by individual MCP tool.
- Aggregate skill usage by loaded Skill ID, not under the generic `skill.load` tool.
- Keep statistics independent of dynamic permission, plan-mode, work-state, and capability visibility gates.
- Update counts while a session is running and reconcile them when the run settles.

## Non-goals

- Replacing or deleting the existing session capabilities API.
- Showing all available tools, candidate skills, or mounted-but-unused MCP servers.
- Combining child-agent calls into the parent session.
- Showing success/failure breakdowns in the initial UI.
- Treating context-token usage as invocation usage.

## User-visible behavior

The runtime-details panel contains a section titled `调用统计` in Chinese and `Invocation usage` in English.

Example:

```text
调用统计                              8 次
──────────────────────────────────────────
工具                                  5 次
  Browser Navigate                    ×3
  Browser Click                       ×2

技能                                  1 次
  brainstorming                       ×1

MCP                                   2 次
  GitHub                              ×2
```

Only categories containing at least one invoked object are rendered. If no calls exist, the panel shows:

```text
调用统计  0 次
本会话尚未调用工具、技能或 MCP。
```

The panel does not render:

- lock icons;
- `visible/available` counts;
- unused tools;
- inactive or candidate skills;
- mounted-but-unused MCP servers;
- success/failure details.

## Unified data model

The API returns a normalized list:

```ts
export type SessionInvocationKind = "tool" | "skill" | "mcp";

export interface SessionInvocationUsageItem {
  kind: SessionInvocationKind;
  id: string;
  label: string;
  callCount: number;
  lastCalledAt: string;
}

export interface SessionInvocationUsageResponse {
  items: SessionInvocationUsageItem[];
  totalCalls: number;
}
```

`id` is stable within its `kind`; consumers must use the compound identity `${kind}:${id}`.

The first version intentionally exposes only total calls. Status-specific counters may be added later without changing the object identity or grouping rules.

## API

Add:

```text
GET /api/agent-runtime/sessions/:sessionId/invocation-usage
```

The endpoint resolves the session through the existing runtime store and returns `SessionInvocationUsageResponse`.

The existing endpoint remains available:

```text
GET /api/agent-runtime/sessions/:sessionId/capabilities
```

It may continue supporting configuration or permission-oriented consumers, but it no longer drives the runtime-details capability list.

## Backend aggregation

Create a focused service such as:

```text
api/services/agent-runtime/session-invocation-usage.ts
```

The service reads only direct calls belonging to the selected session:

```ts
agentRuntimeStore.listToolCalls(sessionId)
```

It must not call `listSessionTree`, merge child sessions, or infer usage from context composition.

Each persisted `ToolCallRecord` represents one attempted invocation and contributes at most one count. The following statuses all count:

- `pending`
- `running`
- `completed`
- `compacted`
- `failed`
- `denied`
- `cancelled`

A record changing status does not increment the count again because it retains the same tool-call identity.

### Skill normalization

For records where:

```ts
toolId === "skill.load"
```

read `inputRef.skillId` and normalize to:

```ts
{
  kind: "skill",
  id: skillId,
  label: resolvedSkillLabel,
}
```

The generic `skill.load` tool is not emitted as a Tool item.

Skill labels are resolved from the skill registry using the session project. If the skill is no longer installed or metadata resolution fails, use the Skill ID as the label.

If a malformed `skill.load` record has no valid `skillId`, fall back to a Tool item for `skill.load` rather than discarding a genuine persisted invocation.

### MCP normalization

For records where:

```ts
category === "mcp"
```

parse IDs following the runtime convention:

```text
mcp.<serverId>.<toolName>
```

Normalize all tools from the same server to:

```ts
{
  kind: "mcp",
  id: serverId,
  label: resolvedServerName,
}
```

The server name is resolved from project MCP settings. If the server configuration has been removed or cannot be read, use `serverId` as the label.

Malformed MCP IDs fall back to an ordinary Tool item using the original tool ID so a persisted call is not silently lost.

### Tool normalization

All remaining calls normalize to:

```ts
{
  kind: "tool",
  id: toolId,
  label: resolvedToolLabel,
}
```

Use the registered tool label when available. Historical or externally supplied tools may no longer exist in the active registry; in that case, generate a readable label from the tool ID and retain the original ID as identity.

`tools.invalid` is excluded because it records model/tool-name recovery rather than invocation of a real capability object.

### Aggregation and ordering

Aggregate by compound key:

```text
<kind>:<id>
```

For each group:

- increment `callCount` once per persisted record;
- set `lastCalledAt` to the latest `startedAt` in the group.

Order categories in the UI as:

1. Tool
2. Skill
3. MCP

Within each category, order by:

1. `callCount` descending;
2. `lastCalledAt` descending;
3. `label` ascending for deterministic ties.

The backend should return deterministically sorted items so non-UI clients receive the same semantics. The UI may group the already sorted items without redefining aggregation rules.

`totalCalls` is the sum of all emitted item counts after exclusions. Thus excluded `tools.invalid` records do not contribute to the displayed total.

## Frontend API and state

Add the response types and an API client method to the existing agent-runtime client:

```ts
getSessionInvocationUsage(sessionId)
```

Add session-detail state and cache fields:

```ts
sessionInvocationUsage: SessionInvocationUsageResponse | null
```

Invocation usage belongs to the same selected-session and per-session detail cache boundaries as stats, runs, steps, and tool calls.

The existing `sessionCapabilities` state may remain for other consumers, but the runtime profile panel must not require it to render invocation usage.

## Refresh behavior

Fetch invocation usage:

1. when the selected session detail is first loaded;
2. when switching to a session without a current cached snapshot;
3. after the stream observes a previously unseen ToolCall ID, using a short debounce of approximately 500 ms;
4. immediately after `run_completed` or `run_failed` to reconcile final persisted state;
5. after an explicit detail refresh.

Do not refetch on every token or every status update of the same ToolCall ID.

The server remains the source of truth. Live refreshes update the cached snapshot rather than maintaining a separate client-side aggregation algorithm.

If a refresh fails, retain the most recent successful snapshot. Initial-load failure leaves the panel in its unavailable/empty loading state without affecting the rest of the runtime details.

## UI components

Replace the current runtime-details use of `SessionCapabilitiesPanel` with a focused component such as:

```text
SessionInvocationUsagePanel.tsx
```

Responsibilities:

- render the overall total;
- group items by `kind`;
- omit empty groups;
- render kind icon, localized group label, object label, and `×N` count;
- render the zero-call empty state;
- contain no capability-gating or lock-state logic.

Icons:

- Tool: `Wrench`
- Skill: `Sparkles`
- MCP: `Plug`

Each item row displays only its icon/name context and call count. `lastCalledAt` exists for ordering and is not displayed in the initial version.

The old panel's complete inventory, candidate sections, lock icons, and `visible/available` total are removed from runtime details. The component can remain in the repository only if another consumer still needs it; otherwise it should be removed with its obsolete tests.

## Localization

At minimum provide Chinese and English strings for:

- Invocation usage / 调用统计
- Tools / 工具
- Skills / 技能
- MCP
- calls / 次
- This session has not invoked any tools, skills, or MCP servers. / 本会话尚未调用工具、技能或 MCP。

Labels resolved from registries or project configuration are displayed as stored and are not translated by the panel.

## Error handling and compatibility

- Missing historical metadata must not make the endpoint fail; use stable-ID fallbacks.
- Missing project MCP settings must not discard historical MCP calls.
- Malformed Skill or MCP records must remain countable through Tool fallback normalization.
- Non-native backends are supported when they persist ToolCall records. Their unknown tools use readable tool-ID fallback labels.
- Sessions with no ToolCall records return `{ items: [], totalCalls: 0 }`.
- The endpoint must preserve normal not-found behavior for an unknown session.

No database migration is required because aggregation uses existing persisted ToolCall records.

## Testing strategy

### Backend unit tests

Cover:

1. ordinary tools aggregated by `toolId`;
2. repeated calls counted once per record;
3. every persisted call status included;
4. `skill.load` aggregated by `inputRef.skillId`;
5. distinct skills kept separate;
6. missing Skill metadata falling back to Skill ID;
7. malformed Skill records falling back to Tool usage;
8. multiple MCP tools aggregated by server ID;
9. distinct MCP servers kept separate;
10. removed MCP configuration falling back to server ID;
11. malformed MCP records falling back to Tool usage;
12. `tools.invalid` excluded from items and total;
13. child-session calls excluded;
14. deterministic count/time/label ordering;
15. empty sessions returning an empty response.

### Route tests

Cover successful serialization and unknown-session behavior for the new endpoint.

### Frontend component tests

Cover:

1. only invoked objects rendered;
2. Tool, Skill, and MCP grouping;
3. empty groups omitted;
4. total and per-item counts rendered;
5. empty state rendered;
6. locks, `0/42`, candidate skills, and unused MCP servers absent;
7. long labels truncate without hiding counts.

### Frontend state tests

Cover:

1. initial session-detail fetch;
2. per-session caching;
3. debounced refresh for a newly observed ToolCall ID;
4. no duplicate refresh for status changes to an existing call;
5. final reconciliation on run completion/failure;
6. stale successful data retained on refresh failure;
7. session switching cannot apply a late response to the wrong session.

## Acceptance criteria

- Runtime details list only Tool, Skill, and MCP objects actually invoked by the selected session.
- Every listed object shows its cumulative session call count.
- Skills are identified by Skill ID and MCP usage is aggregated by MCP Server ID.
- Child-agent activity does not alter the parent session's counts.
- The panel contains no capability locks, unused capability inventory, or `visible/available` counter.
- Counts update during active runs and are correct after the run settles.
- Existing context composition continues to show token usage independently of invocation counts.
- Existing capabilities behavior outside this panel remains compatible.
