import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useAgentSessionStore } from "../state/agentSessionStore";
import { TRANSCRIPT_ENTRY_READY_EVENT } from "../TimelineLazyEntry";
import { useWorkspaceSwitchReadiness } from "../useWorkspaceSwitchReadiness";

type Props = {
  projectId: string;
  routeSessionId: string | null;
  routeSettled: boolean;
};

function createRoot(): HTMLElement {
  const root = document.createElement("div");
  document.body.appendChild(root);
  return root;
}

beforeEach(() => {
  useAgentSessionStore.setState({
    ...useAgentSessionStore.getInitialState(),
    projectId: "a",
    sessionListLoading: false,
    sessionListLoadedAt: Date.now(),
    detailLoading: false,
    detailRefreshing: false,
    selectedSessionId: null,
  });
});

afterEach(() => {
  document.body.innerHTML = "";
  vi.useRealTimers();
});

it("waits until the store is bound to the workspace the route asked for", () => {
  const root = createRoot();
  const ref = { current: root };
  const view = renderHook(
    (props: Props) =>
      useWorkspaceSwitchReadiness(ref, props.projectId, props.routeSessionId, props.routeSettled),
    { initialProps: { projectId: "a", routeSessionId: null, routeSettled: true } },
  );
  expect(view.result.current).toBe(true);

  view.rerender({ projectId: "b", routeSessionId: null, routeSettled: true });
  expect(view.result.current).toBe(false);

  act(() => useAgentSessionStore.setState({ projectId: "b" }));
  expect(view.result.current).toBe(true);
});

it("waits for the new workspace list instead of revealing an empty one", () => {
  const root = createRoot();
  const ref = { current: root };
  useAgentSessionStore.setState({ projectId: "a" });
  const view = renderHook(
    (props: Props) =>
      useWorkspaceSwitchReadiness(ref, props.projectId, props.routeSessionId, props.routeSettled),
    { initialProps: { projectId: "a", routeSessionId: null, routeSettled: true } },
  );
  view.rerender({ projectId: "b", routeSessionId: null, routeSettled: true });
  act(() => {
    useAgentSessionStore.setState({
      projectId: "b",
      sessionListLoading: true,
      sessionListLoadedAt: 0,
    });
  });
  expect(view.result.current).toBe(false);

  act(() => useAgentSessionStore.setState({ sessionListLoading: false }));
  expect(view.result.current).toBe(false);

  act(() => useAgentSessionStore.setState({ sessionListLoadedAt: Date.now() }));
  expect(view.result.current).toBe(true);
});

it("holds the blur while the route still has to replay the last visit", () => {
  const root = createRoot();
  const ref = { current: root };
  const view = renderHook(
    (props: Props) =>
      useWorkspaceSwitchReadiness(ref, props.projectId, props.routeSessionId, props.routeSettled),
    { initialProps: { projectId: "a", routeSessionId: null, routeSettled: true } },
  );
  view.rerender({ projectId: "b", routeSessionId: null, routeSettled: false });
  act(() => useAgentSessionStore.setState({ projectId: "b" }));
  expect(view.result.current).toBe(false);

  view.rerender({ projectId: "b", routeSessionId: "s1", routeSettled: true });
  expect(view.result.current).toBe(false);
});

it("waits for the requested conversation and its history", () => {
  const root = createRoot();
  const ref = { current: root };
  const view = renderHook(
    (props: Props) =>
      useWorkspaceSwitchReadiness(ref, props.projectId, props.routeSessionId, props.routeSettled),
    { initialProps: { projectId: "a", routeSessionId: null, routeSettled: true } },
  );
  view.rerender({ projectId: "b", routeSessionId: "s1", routeSettled: true });
  act(() => useAgentSessionStore.setState({ projectId: "b" }));
  expect(view.result.current).toBe(false);

  act(() =>
    useAgentSessionStore.setState({ selectedSessionId: "s1", detailLoading: true }),
  );
  expect(view.result.current).toBe(false);

  act(() => useAgentSessionStore.setState({ detailLoading: false }));
  expect(view.result.current).toBe(true);

  act(() => useAgentSessionStore.setState({ detailRefreshing: true }));
  expect(view.result.current).toBe(false);
});

it("waits for the restored transcript records to mount", () => {
  const root = createRoot();
  root.innerHTML = '<div data-session-entry="e1" data-entry-pending="true"></div>';
  const ref = { current: root };
  const view = renderHook(
    (props: Props) =>
      useWorkspaceSwitchReadiness(ref, props.projectId, props.routeSessionId, props.routeSettled),
    { initialProps: { projectId: "a", routeSessionId: null, routeSettled: true } },
  );
  expect(view.result.current).toBe(true);

  view.rerender({ projectId: "b", routeSessionId: null, routeSettled: true });
  act(() => useAgentSessionStore.setState({ projectId: "b" }));
  expect(view.result.current).toBe(false);

  const node = root.querySelector("[data-session-entry]")!;
  node.removeAttribute("data-entry-pending");
  act(() => {
    node.dispatchEvent(
      new CustomEvent(TRANSCRIPT_ENTRY_READY_EVENT, { bubbles: true }),
    );
  });
  expect(view.result.current).toBe(true);
});
