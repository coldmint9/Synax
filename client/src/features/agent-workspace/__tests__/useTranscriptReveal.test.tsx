import { renderHook } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useTranscriptReveal } from "../useTranscriptReveal";

it("reveals readable content before paint without waiting for media or animation frames", () => {
  const frame = vi.spyOn(window, "requestAnimationFrame");
  const root = { current: document.createElement("div") };
  root.current.innerHTML = '<p>Saved answer</p><span data-transcript-pending="true"></span><video></video>';
  const view = renderHook(() => useTranscriptReveal(root, "running", true, true));
  expect(view.result.current).toBe(true);
  expect(frame).not.toHaveBeenCalled();
  frame.mockRestore();
});

it("isolates rapid switches, waits for cold history and stays visible during refresh", () => {
  const root = { current: document.createElement("div") };
  const view = renderHook(({ id, ready, active }) => useTranscriptReveal(root, id, ready, active), {
    initialProps: { id: "a", ready: false, active: true },
  });
  expect(view.result.current).toBe(false);
  view.rerender({ id: "a", ready: true, active: true });
  expect(view.result.current).toBe(true);
  view.rerender({ id: "a", ready: false, active: true });
  expect(view.result.current).toBe(true);
  view.rerender({ id: "b", ready: true, active: true });
  expect(view.result.current).toBe(true);
  view.rerender({ id: "c", ready: false, active: true });
  expect(view.result.current).toBe(false);
  view.rerender({ id: "c", ready: true, active: false });
  expect(view.result.current).toBe(false);
  view.rerender({ id: "c", ready: true, active: true });
  expect(view.result.current).toBe(true);
});
