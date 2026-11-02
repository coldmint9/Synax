import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { TRANSCRIPT_ENTRY_READY_EVENT } from "../TimelineLazyEntry";
import { useTranscriptRenderPending } from "../useTranscriptRenderPending";

function createRoot(): HTMLElement {
  const root = document.createElement("div");
  document.body.appendChild(root);
  return root;
}

afterEach(() => {
  document.body.innerHTML = "";
});

it("waits for every deferred entry in the rendered window after a switch", () => {
  const root = createRoot();
  root.innerHTML = `
    <div data-session-entry="e1"></div>
    <div data-session-entry="e2" data-entry-pending="true"></div>
    <div data-session-entry="e3" data-entry-pending="true"></div>
  `;
  const ref = { current: root };
  const view = renderHook(
    ({ id }: { id: string }) => useTranscriptRenderPending(ref, id, true),
    { initialProps: { id: "a" } },
  );
  // The first paint is not a switch.
  expect(view.result.current).toBe(false);

  view.rerender({ id: "b" });
  expect(view.result.current).toBe(true);

  const ready = (entryId: string) =>
    act(() => {
      root
        .querySelector(`[data-session-entry="${entryId}"]`)!
        .dispatchEvent(new CustomEvent(TRANSCRIPT_ENTRY_READY_EVENT, { bubbles: true }));
    });

  ready("e2");
  expect(view.result.current).toBe(true);
  ready("e3");
  expect(view.result.current).toBe(false);
});

it("does not wait on entries the virtual window never rendered", () => {
  const root = createRoot();
  root.innerHTML = `<div data-session-entry="e1"></div>`;
  const ref = { current: root };
  const view = renderHook(
    ({ id }: { id: string }) => useTranscriptRenderPending(ref, id, true),
    { initialProps: { id: "a" } },
  );
  view.rerender({ id: "b" });
  expect(view.result.current).toBe(false);
});

it("ignores readiness events from entries it is not waiting on", () => {
  const root = createRoot();
  root.innerHTML = `<div data-session-entry="e1" data-entry-pending="true"></div>`;
  const ref = { current: root };
  const view = renderHook(
    ({ id }: { id: string }) => useTranscriptRenderPending(ref, id, true),
    { initialProps: { id: "a" } },
  );
  view.rerender({ id: "b" });
  act(() => {
    root
      .querySelector("[data-session-entry]")!
      .dispatchEvent(new CustomEvent(TRANSCRIPT_ENTRY_READY_EVENT, { bubbles: true }));
  });
  expect(view.result.current).toBe(false);
  act(() => {
    document.body.dispatchEvent(
      new CustomEvent(TRANSCRIPT_ENTRY_READY_EVENT, { bubbles: true }),
    );
  });
  expect(view.result.current).toBe(false);
});
