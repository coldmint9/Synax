import { render } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { OverlayStateObserver } from "./OverlayStateObserver";

it("reports actual state transitions without false notifications on callback replacement", () => {
  const first = vi.fn();
  const next = vi.fn();
  const view = render(<OverlayStateObserver open={false} onOpenChange={first} />);
  expect(first).toHaveBeenLastCalledWith(false);
  view.rerender(<OverlayStateObserver open onOpenChange={first} />);
  expect(first.mock.calls).toEqual([[false], [true]]);
  view.rerender(<OverlayStateObserver open onOpenChange={next} />);
  expect(first.mock.calls).toEqual([[false], [true]]);
  expect(next).not.toHaveBeenCalled();
  view.rerender(<OverlayStateObserver open={false} onOpenChange={next} />);
  expect(next.mock.calls).toEqual([[false]]);
  view.rerender(<OverlayStateObserver open onOpenChange={next} />);
  view.unmount();
  expect(next.mock.calls).toEqual([[false], [true], [false]]);
});
