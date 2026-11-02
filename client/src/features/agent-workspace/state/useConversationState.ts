import { useEffect, useSyncExternalStore } from "react";
import { useStore } from "zustand";
import { getConversationController, type ConversationState, type ConversationController } from "./conversationController";

const identity = (state: ConversationState) => state;
export function useConversationState<T = ConversationState>(sessionId: string, selector: (state: ConversationState) => T = identity as (state: ConversationState) => T): T {
  const controller = getConversationController(sessionId);
  useEffect(() => controller.retain(), [controller]);
  return useStore(controller.store, selector);
}

const noopSubscribe = () => () => {};
/** Renderers may borrow an already retained controller without owning its lifetime. */
export function useScopedConversationValue<T>(controller: ConversationController | undefined, selector: (state: ConversationState) => T): T | undefined {
  return useSyncExternalStore(controller?.subscribe ?? noopSubscribe,
    () => controller ? selector(controller.getSnapshot()) : undefined);
}
