import { createStore } from "zustand/vanilla";
import { agentRuntimeApi, type AgentInteraction, type AgentInteractionReply, type AgentSession, type AgentRun } from "../../../adapters/transport/agentRuntime";
import { addSessionLiveListener } from "../../../adapters/transport/sessionLiveClient";
import type { LlmRetryState, SessionLiveEvent } from "../../../adapters/transport/sessionLive";
import { EMPTY_STREAMING_BUFFERS, hasStreamingText, isStreamingLiveEmpty, type StreamingLiveBuffers } from "../streamingLiveBlocks";
import type { SessionDetailCacheEntry } from "./agentSessionStore";
import type { CompletedLiveStep } from "./liveStepRetirement";
import { mergeRefreshedHistory, prependHistory } from "./historyWindowMerge";
import { applyConversationEvent, isConversationActive, mergeConversationEventRecords, retireConversationSnapshots, upsertConversationRecord } from "./conversationProjection";
import { projectPendingSubmission, usePendingSubmissionStore } from "./pendingSubmissionStore";
import { compactSessionTail, isSessionHistoryReading } from "./sessionTailWindow";

export interface ConversationState {
  sessionId: string;
  session: AgentSession | null;
  history: SessionDetailCacheEntry;
  interactions: AgentInteraction[];
  interactionLoading: boolean;
  interactionError: string | null;
  interactionSending: boolean;
  loading: boolean;
  loadingEarlier: boolean;
  error: string | null;
  streamingStepId: string | null;
  streamingLive: StreamingLiveBuffers;
  streamingCompletedSteps: CompletedLiveStep[];
  streamingRetry: LlmRetryState | null;
}

function emptyState(sessionId: string): ConversationState {
  return {
    sessionId, session: null, loading: true, loadingEarlier: false, error: null,
    history: { messages: [], runs: [], steps: [], toolCalls: [], events: [], permissions: [], sessionStats: null, sessionTodos: [], sessionInvocationUsage: null, cachedAt: 0 },
    interactions: [], interactionLoading: false, interactionError: null, interactionSending: false,
    streamingStepId: null, streamingLive: EMPTY_STREAMING_BUFFERS, streamingCompletedSteps: [], streamingRetry: null,
  };
}

/** One retained transcript per session, independent of the selected workspace. */
export class ConversationController {
  readonly store;
  private state: ConversationState;
  private owners = 0;
  private releaseLive?: () => void;
  private releasePending?: () => void;
  private releaseTimer?: ReturnType<typeof setTimeout>;
  private publishTimer?: ReturnType<typeof setTimeout>;
  private read?: Promise<void>;
  private readAgain = false;
  private readEvents: SessionLiveEvent[] | null = null;
  private interactionsRead?: Promise<void>;
  private interactionsAgain = false;
  private interactionsVersion = 0;
  private olderRead?: Promise<void>;
  private terminalRunIds = new Set<string>();
  private pendingProjection?: {
    pending: ReturnType<typeof usePendingSubmissionStore.getState>["items"][string] | undefined;
    messages: SessionDetailCacheEntry["messages"];
    runs: SessionDetailCacheEntry["runs"];
    value: ReturnType<typeof projectPendingSubmission>;
  };
  private projectedHistory?: { source: SessionDetailCacheEntry; messages: SessionDetailCacheEntry["messages"]; run?: AgentRun; value: SessionDetailCacheEntry };

  constructor(readonly sessionId: string) {
    this.state = emptyState(sessionId);
    this.store = createStore<ConversationState>(() => this.state);
  }

  getSnapshot = () => this.store.getState();
  subscribe = (listener: () => void) => this.store.subscribe(listener);

  seedSession = (session: AgentSession): void => {
    if (session.id !== this.sessionId || this.state.session) return;
    this.state = { ...this.state, session }; this.publish();
  };

  acceptRun = (run: AgentRun): void => {
    if (run.sessionId !== this.sessionId || this.terminalRunIds.has(run.id)) return;
    const existing = this.state.history.runs.find(item => item.id === run.id);
    if (existing && !["queued", "running", "waiting_permission", "waiting_input"].includes(existing.status)) return;
    if (this.state.session?.activeRunId && this.state.session.activeRunId !== run.id) return;
    // A slow summary read can overlap the POST acknowledgement. Journal this
    // transition just like a transport event so that read cannot undo it.
    this.receive({ type: "runtime_state", sessionId: this.sessionId, run: existing ?? run,
      patch: existing ? {} : { status: "running", activeRunId: run.id, blockedReason: null, pendingResumeToken: null }, reset: false, refresh: false });
  };

  retain = (): (() => void) => {
    this.owners++;
    clearTimeout(this.releaseTimer);
    if (!this.releaseLive) {
      // Install the journal before subscribing: transports may synchronously
      // replay a snapshot, before the first HTTP request has even started.
      this.readEvents ??= [];
      this.releaseLive = addSessionLiveListener(this.sessionId, this.receive, { replaySnapshot: true });
      this.releasePending = usePendingSubmissionStore.subscribe((next, previous) => {
        if (next.items[this.sessionId] !== previous.items[this.sessionId]) this.publish();
      });
      this.publish();
      void this.refresh();
      void this.refreshInteractions();
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      if (--this.owners !== 0) return;
      // React StrictMode's remount shares the connection and initial read.
      this.releaseTimer = setTimeout(() => {
        if (this.owners) return;
        this.releaseLive?.(); this.releaseLive = undefined;
        this.releasePending?.(); this.releasePending = undefined;
        this.publish();
        pruneControllers();
      }, 0);
    };
  };

  private publish = () => {
    clearTimeout(this.publishTimer); this.publishTimer = undefined;
    const pending = usePendingSubmissionStore.getState().items[this.sessionId];
    const cached = this.pendingProjection;
    const projection = cached && cached.pending === pending && cached.messages === this.state.history.messages && cached.runs === this.state.history.runs
      ? cached.value : projectPendingSubmission(pending, this.state.history.runs, this.state.history.messages);
    this.pendingProjection = { pending, messages: this.state.history.messages, runs: this.state.history.runs, value: projection };
    let history = this.state.history;
    if (projection.messages !== history.messages) {
      const cachedHistory = this.projectedHistory;
      const value = cachedHistory?.source === history && cachedHistory.messages === projection.messages && cachedHistory.run === projection.run ? cachedHistory.value
        : { ...history, messages: projection.messages, runs: projection.run ? upsertConversationRecord(history.runs, projection.run) : history.runs };
      this.projectedHistory = { source: history, messages: projection.messages, run: projection.run, value };
      history = value;
    }
    const state = history === this.state.history ? this.state : { ...this.state, history };
    this.store.setState(state, true);
    if (pending && projection.confirmed) usePendingSubmissionStore.getState().clear(this.sessionId, pending.requestId);
  };

  private receive = (event: SessionLiveEvent) => {
    if ("sessionId" in event && event.sessionId !== this.sessionId) return;
    const delta = event.type === "message_delta" || event.type === "thought_delta";
    // Store only record-bearing events during an in-flight read. Live text is
    // already applied and must never be replayed or counted twice.
    if (this.readEvents && !delta && event.type !== "retry_status") this.readEvents.push(event);
    const previous = this.state;
    if (event.type === "runtime_state" && event.patch.status && !isConversationActive(event.patch.status)) {
      const runId = event.run?.id ?? previous.session?.activeRunId;
      if (runId) this.terminalRunIds.add(runId);
    } else if (event.type === "runtime_snapshot" && event.run && !isConversationActive(event.session.status)) this.terminalRunIds.add(event.run.id);
    this.state = applyConversationEvent(previous, event);
    if (this.state.history !== previous.history && !this.state.history.historyPagesLoaded && !isSessionHistoryReading(this.sessionId)) {
      const history = compactSessionTail(this.state.history);
      if (history !== this.state.history) this.state = { ...this.state, history };
    }
    if (this.state !== previous) {
      if (!delta || isStreamingLiveEmpty(previous.streamingLive) || (event.type === "message_delta" && !hasStreamingText(previous.streamingLive))) this.publish();
      else this.publishTimer ??= setTimeout(this.publish, 32);
    }
    if (event.type === "event" && event.event.sessionId === this.sessionId && event.event.type.startsWith("interaction_")) void this.refreshInteractions();
    if (event.type === "runtime_state" && event.refresh) {
      this.readEvents ??= [event];
      void this.refresh();
      if (event.patch.status === "waiting_input") void this.refreshInteractions();
    } else if (event.type === "runtime_snapshot" && this.state.history.cachedAt) {
      this.readEvents ??= [event];
      void this.refresh();
      void this.refreshInteractions();
    } else if (event.type === "domain_reconnected") {
      void this.refresh();
      void this.refreshInteractions();
    }
  };

  refresh = (): Promise<void> => {
    if (this.read) { this.readAgain = true; return this.read; }
    this.readEvents ??= [];
    this.read = this.readHistory().finally(() => {
      this.read = undefined;
      if (this.readAgain) { this.readAgain = false; void this.refresh(); }
    });
    return this.read;
  };

  private async readHistory(): Promise<void> {
    try {
      const [{ session }, history] = await Promise.all([
        agentRuntimeApi.getSessionSummary(this.sessionId),
        agentRuntimeApi.historyWindow(this.sessionId, undefined, this.state.history.historyWindow?.syncCursor),
      ]);
      const previous = this.state.history;
      const latest: SessionDetailCacheEntry = { ...history, sessionStats: previous.sessionStats, sessionTodos: previous.sessionTodos, sessionInvocationUsage: previous.sessionInvocationUsage, cachedAt: Date.now() };
      let next: ConversationState = { ...this.state, session, history: mergeRefreshedHistory(previous.cachedAt ? previous : undefined, latest), loading: false, error: null };
      // Snapshot hydration and the durable history endpoint can straddle a
      // write. Keep identities of already painted live rows until their
      // persisted content lands, so terminal retirement can match them.
      const visibleIds = new Set(this.state.streamingCompletedSteps.map(item => item.stepId));
      if (this.state.streamingStepId) visibleIds.add(this.state.streamingStepId);
      const stepIds = new Set(next.history.steps.map(item => item.id));
      const missingSteps = previous.steps.filter(item => visibleIds.has(item.id) && !stepIds.has(item.id));
      if (missingSteps.length) next = { ...next, history: { ...next.history, steps: [...next.history.steps, ...missingSteps] } };
      for (const event of this.readEvents ?? []) next = mergeConversationEventRecords(next, event);
      this.readEvents = null;
      this.state = retireConversationSnapshots(next);
      this.publish();
      if (history.historyWindow.hasMoreChanges) this.readAgain = true;
    } catch (error) {
      this.readEvents = null;
      this.state = { ...this.state, loading: false, error: error instanceof Error ? error.message : String(error) };
      this.publish();
    }
  }

  loadEarlier = (): Promise<void> => {
    if (this.olderRead) return this.olderRead;
    const cursor = this.state.history.historyWindow?.olderCursor;
    if (!cursor) return Promise.resolve();
    const epoch = this.state.history.historyWindow?.epoch;
    this.state = { ...this.state, loadingEarlier: true }; this.publish();
    this.olderRead = agentRuntimeApi.historyWindow(this.sessionId, cursor).then(page => {
      if (this.state.history.historyWindow?.epoch !== epoch || page.historyWindow.epoch !== epoch) return;
      this.state = retireConversationSnapshots({ ...this.state, history: prependHistory(this.state.history, page), error: null });
    }).catch(error => { this.state = { ...this.state, error: error instanceof Error ? error.message : String(error) }; })
      .finally(() => { this.olderRead = undefined; this.state = { ...this.state, loadingEarlier: false }; this.publish(); });
    return this.olderRead;
  };

  refreshInteractions = (): Promise<void> => {
    if (this.interactionsRead) { this.interactionsAgain = true; return this.interactionsRead; }
    const version = ++this.interactionsVersion;
    this.state = { ...this.state, interactionLoading: true }; this.publish();
    this.interactionsRead = agentRuntimeApi.listInteractions(this.sessionId).then(({ interactions }) => {
      if (version !== this.interactionsVersion) return;
      this.state = { ...this.state, interactions: interactions.filter(item => item.sessionId === this.sessionId), interactionError: null };
    }).catch(error => {
      if (version === this.interactionsVersion) this.state = { ...this.state, interactionError: error instanceof Error ? error.message : String(error) };
    }).finally(() => {
      this.interactionsRead = undefined;
      this.state = { ...this.state, interactionLoading: false }; this.publish();
      if (this.interactionsAgain) { this.interactionsAgain = false; void this.refreshInteractions(); }
    });
    return this.interactionsRead;
  };

  replyInteraction = async (interactionId: string, body: AgentInteractionReply): Promise<void> => {
    this.state = { ...this.state, interactionSending: true, interactionError: null }; this.publish();
    try {
      const { interaction } = await agentRuntimeApi.replyInteraction(this.sessionId, interactionId, body);
      ++this.interactionsVersion;
      this.state = { ...this.state, interactions: upsertConversationRecord(this.state.interactions, interaction) };
      void this.refresh();
    } catch (error) {
      this.state = { ...this.state, interactionError: error instanceof Error ? error.message : String(error) };
      throw error;
    } finally { this.state = { ...this.state, interactionSending: false }; this.publish(); }
  };

  replyPermission = async (permissionId: string, reply: "once" | "always" | "reject", message?: string): Promise<void> => {
    const permission = await agentRuntimeApi.replyPermission(this.sessionId, permissionId, reply, message);
    this.readEvents ??= [];
    this.receive({ type: "permission_updated", permission });
    void this.refresh();
  };

  get retained(): boolean { return this.owners > 0; }
}

const controllers = new Map<string, ConversationController>();
function pruneControllers(): void {
  if (controllers.size <= 16) return;
  for (const [id, controller] of controllers) {
    if (!controller.retained) controllers.delete(id);
    if (controllers.size <= 16) break;
  }
}
export function getConversationController(sessionId: string): ConversationController {
  let controller = controllers.get(sessionId);
  if (!controller) { controller = new ConversationController(sessionId); controllers.set(sessionId, controller); }
  return controller;
}
