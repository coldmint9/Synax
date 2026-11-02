import type { AgentSession } from "../../adapters/transport/agentRuntime";
import type { TurnContentBlock } from "./buildInterleavedTurns";

/**
 * Tools that hand work to a child session.
 *
 * `subagent.delegate` runs a child to completion before the parent continues,
 * `subagent.lifecycle` starts or inspects it. Both name the same child, and the
 * transcript owns exactly one card per child, so the matching rule has to be
 * shared by the persisted timeline and the live step.
 */
const SUBAGENT_CALL_TOOL_IDS = new Set(["subagent.delegate", "subagent.lifecycle"]);

export function isSubagentDelegationCall(call: { toolId: string }): boolean {
  return SUBAGENT_CALL_TOOL_IDS.has(call.toolId);
}

/**
 * The child id a delegation record carries.
 *
 * A delegated call returns `outputRef.childSessionId` (sometimes nested under
 * `result`), a lifecycle call passes `childSessionId` in its input, and older
 * records only expose `taskId`. Any of those is authoritative; only records
 * without an id fall back to the nearest child.
 */
export function readSubagentSessionId(
  value: unknown,
  seen = new Set<unknown>(),
): string | null {
  if (!value || typeof value !== "object" || seen.has(value)) return null;
  seen.add(value);
  const record = value as Record<string, unknown>;
  for (const key of ["childSessionId", "taskId"]) {
    if (typeof record[key] === "string" && record[key].trim())
      return (record[key] as string).trim();
  }
  if (record.session && typeof record.session === "object") {
    const id = (record.session as Record<string, unknown>).id;
    if (typeof id === "string" && id.trim()) return id.trim();
  }
  for (const key of ["result", "output", "data", "payload"]) {
    const nested = readSubagentSessionId(record[key], seen);
    if (nested) return nested;
  }
  return null;
}

export interface SubagentCallReference {
  /** Already-resolved id, carried by rendered tool call views. */
  childSessionId?: string | null;
  inputRef?: unknown;
  outputRef?: unknown;
  startedAt?: string | null;
}

/** The child id a persisted tool call or a rendered call view exposes. */
export function subagentChildIdOf(call: SubagentCallReference): string | null {
  return (
    call.childSessionId ??
    readSubagentSessionId(call.inputRef) ??
    readSubagentSessionId(call.outputRef)
  );
}

/**
 * Which child a delegation call belongs to.
 *
 * An explicit id wins. Otherwise the child created closest to the call's start
 * time is the one this record started, which is how a blocking delegate whose
 * result has not landed yet still owns a card.
 */
export function childForSubagentCall(
  call: SubagentCallReference,
  parentSessionId: string,
  childSessions: readonly AgentSession[],
  claimed: ReadonlySet<string>,
): AgentSession | undefined {
  const available = childSessions.filter(
    (child) => child.parentSessionId === parentSessionId && !claimed.has(child.id),
  );
  const explicitId = subagentChildIdOf(call);
  if (explicitId) {
    const explicit = available.find((child) => child.id === explicitId);
    if (explicit) return explicit;
    // The child exists and already owns a card: this record is a later
    // lifecycle action on it, not a second delegation.
    if (
      childSessions.some(
        (child) =>
          child.id === explicitId && child.parentSessionId === parentSessionId,
      )
    )
      return undefined;
  }
  if (!available.length) return undefined;
  const startedAt = call.startedAt ? Date.parse(call.startedAt) : Number.NaN;
  if (!Number.isFinite(startedAt)) return available[0];
  return [...available].sort(
    (a, b) =>
      Math.abs(Date.parse(a.createdAt) - startedAt) -
      Math.abs(Date.parse(b.createdAt) - startedAt),
  )[0];
}

/**
 * Insert one card per delegation call into a rendered block list.
 *
 * The live step never passes through `buildInterleavedTurns`, so its delegation
 * rows would otherwise stay plain tool lines until the step is persisted. Cards
 * already in the list are left alone, and their child is never claimed twice.
 */
export function withSubagentCards(
  blocks: readonly TurnContentBlock[],
  options: {
    parentSessionId?: string | null;
    childSessions?: readonly AgentSession[];
    /** Fallback anchor for calls that carry no explicit child id. */
    startedAt?: string | null;
  },
): TurnContentBlock[] {
  const rows = [...blocks];
  const { parentSessionId, childSessions, startedAt } = options;
  if (!parentSessionId || !childSessions?.length) return rows;
  const claimed = new Set(
    rows.flatMap((block) =>
      block.type === "sub_session" ? [block.session.id] : [],
    ),
  );
  const result: TurnContentBlock[] = [];
  for (const block of rows) {
    result.push(block);
    const calls =
      block.type === "tool_call"
        ? [block.call]
        : block.type === "tool_call_group"
          ? block.calls
          : [];
    for (const call of calls) {
      if (!isSubagentDelegationCall(call)) continue;
      const child = childForSubagentCall(
        {
          childSessionId: call.childSessionId,
          startedAt: call.startedAt ?? startedAt,
        },
        parentSessionId,
        childSessions,
        claimed,
      );
      if (!child) continue;
      claimed.add(child.id);
      result.push({ type: "sub_session", session: child });
    }
  }
  return result;
}
