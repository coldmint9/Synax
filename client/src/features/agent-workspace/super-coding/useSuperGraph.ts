import { useCallback, useEffect, useRef, useState } from "react";
import type {
  SuperCommand,
  SuperCommandResult,
  SuperGraph,
  SuperNodeMessage,
} from "../../../../../packages/contracts/super-coding";
import { superCodingApi } from "../../../adapters/transport/super-coding";
import { subscribe } from "../../../adapters/transport/runtimeEventBus";

interface SuperGraphState {
  graph: SuperGraph | null;
  loading: boolean;
  error: string | null;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function parseEvent(event: MessageEvent): Record<string, unknown> | null {
  try {
    const data = JSON.parse(event.data) as Record<string, unknown>;
    return data && typeof data === "object" ? data : null;
  } catch {
    return null;
  }
}

function sessionIdFromEvent(event: MessageEvent): string | null {
  const data = parseEvent(event);
  return typeof data?.sessionId === "string" ? data.sessionId : null;
}

/** A delta only applies forward; an older revision is ignored. */
function applyNodes(
  graph: SuperGraph | null,
  payload: Record<string, unknown> | null,
): SuperGraph | null {
  if (!graph || !payload) return graph;
  const rev = typeof payload.rev === "number" ? payload.rev : graph.rev;
  if (rev < graph.rev) return graph;
  if (!Array.isArray(payload.nodes) || !Array.isArray(payload.edges)) return graph;
  return {
    ...graph,
    rev,
    nodes: payload.nodes as SuperGraph["nodes"],
    edges: payload.edges as SuperGraph["edges"],
    ...(payload.phase === "planning" ||
    payload.phase === "running" ||
    payload.phase === "done" ||
    payload.phase === "stopped" ||
    payload.phase === "failed"
      ? { phase: payload.phase }
      : {}),
    ...(typeof payload.verifyNodeId === "string" || payload.verifyNodeId === null
      ? { verifyNodeId: payload.verifyNodeId }
      : {}),
  };
}

function mergeGraph(
  current: SuperGraph | null,
  incoming: SuperGraph,
): SuperGraph {
  return current && incoming.rev < current.rev ? current : incoming;
}

/**
 * Single data entry for the orchestration card.
 *
 * Realtime path: `super.snapshot` / `super.nodes` from the runtime event bus.
 * `session_changed` stays as a coarse fallback for a node's own session state,
 * so a missed delta still converges after one debounced refetch.
 */
export function useSuperGraph(sessionId: string | null | undefined) {
  const [state, setState] = useState<SuperGraphState>({
    graph: null,
    loading: Boolean(sessionId),
    error: null,
  });
  const [channel, setChannel] = useState<SuperNodeMessage[]>([]);
  const inFlight = useRef(0);
  const debounce = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refresh = useCallback(async () => {
    if (!sessionId) {
      setState({ graph: null, loading: false, error: null });
      return;
    }
    const ticket = ++inFlight.current;
    setState((previous) => ({ ...previous, loading: true }));
    try {
      const snapshot = await superCodingApi.getGraph(sessionId);
      if (ticket !== inFlight.current) return;
      setState((previous) => ({
        graph: snapshot.graph
          ? mergeGraph(previous.graph, snapshot.graph)
          : snapshot.graph,
        loading: false,
        error: null,
      }));
    } catch (error) {
      if (ticket !== inFlight.current) return;
      setState((previous) => ({
        ...previous,
        loading: false,
        error: messageOf(error),
      }));
    }
  }, [sessionId]);

  const loadChannel = useCallback(
    async (nodeId: string | null) => {
      if (!sessionId || !nodeId) {
        setChannel([]);
        return;
      }
      try {
        const response = await superCodingApi.getChannel(sessionId, nodeId);
        setChannel(response.items ?? []);
      } catch {
        setChannel([]);
      }
    },
    [sessionId],
  );

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!sessionId) return;
    const scheduleRefresh = () => {
      if (debounce.current) clearTimeout(debounce.current);
      debounce.current = setTimeout(() => {
        debounce.current = null;
        void refresh();
      }, 200);
    };
    return subscribe({
      events: {
        "super.snapshot": (event) => {
          if (sessionIdFromEvent(event) !== sessionId) return;
          const payload = parseEvent(event)?.patch as
            | { graph?: SuperGraph }
            | undefined;
          if (payload?.graph)
            setState((previous) => ({
              graph: mergeGraph(previous.graph, payload.graph!),
              loading: false,
              error: null,
            }));
        },
        "super.nodes": (event) => {
          if (sessionIdFromEvent(event) !== sessionId) return;
          const payload = parseEvent(event)?.patch as
            | Record<string, unknown>
            | undefined;
          let needsSnapshot = false;
          setState((previous) => {
            // A delta without a base graph cannot be applied; fall back to one
            // snapshot fetch instead of guessing the missing fields.
            if (!previous.graph) needsSnapshot = true;
            return {
              ...previous,
              graph: applyNodes(previous.graph, payload ?? null),
            };
          });
          if (needsSnapshot) scheduleRefresh();
        },
        session_changed: (event) => {
          if (sessionIdFromEvent(event) === sessionId) scheduleRefresh();
        },
      },
      onConnect: scheduleRefresh,
    });
  }, [refresh, sessionId]);

  useEffect(
    () => () => {
      if (debounce.current) clearTimeout(debounce.current);
    },
    [],
  );

  const sendCommand = useCallback(
    async (command: SuperCommand): Promise<SuperCommandResult> => {
      if (!sessionId) return { ok: false, code: "NO_SESSION" };
      try {
        const result = await superCodingApi.sendCommand(sessionId, command);
        if (result.graph)
          setState((previous) => ({
            graph: mergeGraph(previous.graph, result.graph!),
            loading: false,
            error: null,
          }));
        return result;
      } catch (error) {
        const message = messageOf(error);
        setState((previous) => ({ ...previous, error: message }));
        return { ok: false, code: "TRANSPORT", message };
      }
    },
    [sessionId],
  );

  return { ...state, channel, refresh, loadChannel, sendCommand };
}
