import { AuthenticatedEventSource } from "./authenticatedEventSource";
import { useApiConnectivityStore } from "../apiConnectivity";

type EventHandler = (e: MessageEvent) => void;
type ConnectHandler = () => void;

interface Subscription {
  events?: Partial<Record<string, EventHandler>>;
  onConnect?: ConnectHandler;
}

let es: AuthenticatedEventSource | null = null;
let subscribers = new Set<Subscription>();

function connect() {
  if (useApiConnectivityStore.getState().shouldSkipRequest()) return;
  if (es && es.readyState !== AuthenticatedEventSource.CLOSED) return;
  es = new AuthenticatedEventSource("/api/agent-runtime/events/stream");

  es.addEventListener("connected", () => {
    for (const sub of subscribers) sub.onConnect?.();
  });

  const eventTypes = [
    "session_changed",
    "session_process_changed",
    "session_step_completed",
    "session_checkpoint_changed",
    "session_input_queue_changed",
    "session_created",
    "session_deleted",
  ];

  for (const type of eventTypes) {
    es.addEventListener(type, (e: MessageEvent) => {
      for (const sub of subscribers) sub.events?.[type]?.(e);
    });
  }

  const source = es;
  source.onerror = () => {
    // A stream failure is local; the shared transport owns physical reconnect.
    if (source.readyState === AuthenticatedEventSource.CLOSED && es === source) es = null;
  };
}

export function subscribe(sub: Subscription): () => void {
  subscribers.add(sub);
  if (subscribers.size === 1) connect();
  return () => {
    subscribers.delete(sub);
    if (subscribers.size === 0) {
      es?.close();
      es = null;
    }
  };
}

/** Resume SSE after backend connectivity is restored. */
export function resumeRuntimeEventBus(): void {
  if (subscribers.size > 0) connect();
}

export type { Subscription };
