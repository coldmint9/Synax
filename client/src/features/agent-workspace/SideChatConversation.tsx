import { useEffect, useRef } from "react";
import type { AgentSession } from "../../adapters/transport/agentRuntime";
import { addSessionLiveListener } from "../../adapters/transport/sessionLiveClient";
import { InteractionSessionProvider } from "./AgentInteractionPanel";
import { InteractiveSubagentView } from "./InteractiveSubagentView";
import { SessionComposer } from "./SessionComposer";
import { useAgentSessionStore } from "./state/agentSessionStore";
import { getConversationController } from "./state/conversationController";
import { useConversationState } from "./state/useConversationState";
import { useComposerOverlayInset } from "./useComposerOverlayInset";

/** Both transcript and composer observe the child's state, never workspace selection. */
export function SideChatConversation({ session }: { session: AgentSession }) {
  const controller = getConversationController(session.id);
  const observed = useConversationState(session.id, state => state.session);
  const bodyRef = useRef<HTMLDivElement>(null);
  const composerRef = useRef<HTMLDivElement>(null);
  useComposerOverlayInset(bodyRef, composerRef);
  // The inherited primary snapshot stays in the model context, not in the transcript.
  const inheritedThrough = (observed ?? session).sessionMetadata?.sideChatContext?.inheritedThrough;
  useEffect(() => { controller.seedSession(session); }, [controller, session]);
  useEffect(() => addSessionLiveListener(session.id, event => {
    if (event.type === "input_queue_changed")
      void useAgentSessionStore.getState().loadInputQueue(session.id);
  }), [session.id]);
  return <InteractionSessionProvider controller={controller}>
    <div ref={bodyRef} className="side-chat-body">
      <InteractiveSubagentView sessionId={session.id} inheritedThrough={inheritedThrough ?? null} />
    </div>
    <div ref={composerRef} className="side-chat-composer">
      <SessionComposer projectId={session.projectId} session={observed ?? session}
        layout="footer" scopedConversation={controller} />
    </div>
  </InteractionSessionProvider>;
}
