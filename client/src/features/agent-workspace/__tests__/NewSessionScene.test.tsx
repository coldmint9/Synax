import { act, fireEvent, render } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NewSessionScene } from "../NewSessionScene";

const motion = vi.hoisted(() => ({
  reduced: false,
  load: vi.fn(),
  revert: vi.fn(),
  fromTo: vi.fn(),
  quickTo: vi.fn(),
}));
vi.mock("../../../shared/design/motion", () => ({
  reducedMotion: () => motion.reduced,
  loadMotion: motion.load,
}));
let reduce: EventTarget & { matches: boolean };
beforeEach(() => {
  vi.clearAllMocks();
  motion.reduced = false;
  reduce = Object.assign(new EventTarget(), { matches: false });
  vi.spyOn(window, "matchMedia").mockReturnValue(reduce as MediaQueryList);
  motion.load.mockResolvedValue({
    context: (run: () => void) => {
      run();
      return { revert: motion.revert };
    },
    fromTo: motion.fromTo,
    quickTo: motion.quickTo,
  });
});
afterEach(() => vi.restoreAllMocks());
const flush = () =>
  act(async () => {
    await Promise.resolve();
  });
function Scene() {
  return (
    <NewSessionScene>
      <div className="synax-wordmark" />
      <h2>Welcome</h2>
      <div data-welcome-enter="">
        <textarea aria-label="Message" />
      </div>
    </NewSessionScene>
  );
}

describe("welcome scene motion", () => {
  it("keeps entrance animations without moving layers on pointer movement", async () => {
    const { container, unmount } = render(<Scene />);
    await flush();
    expect(motion.fromTo.mock.calls.map(([target]) => target)).toEqual([
      ".synax-wordmark",
      "[data-welcome-enter]",
    ]);
    const scene = container.firstElementChild!;
    fireEvent(
      scene,
      new PointerEvent("pointermove", {
        clientX: 100,
        clientY: 100,
        pointerType: "mouse",
      }),
    );
    fireEvent.pointerLeave(scene);
    expect(motion.quickTo).not.toHaveBeenCalled();
    expect(motion.fromTo).toHaveBeenCalledTimes(2);
    expect(scene.querySelectorAll('[style*="transform"]')).toHaveLength(0);
    unmount();
    expect(motion.revert).toHaveBeenCalledTimes(1);
  });

  it("reverts entrance animations when reduced motion is enabled", async () => {
    render(<Scene />);
    await flush();
    reduce.matches = true;
    act(() => reduce.dispatchEvent(new Event("change")));
    expect(motion.revert).toHaveBeenCalledTimes(1);
  });

  it("does not load animations under reduced motion", async () => {
    motion.reduced = true;
    render(<Scene />);
    await flush();
    expect(motion.load).not.toHaveBeenCalled();
  });
});
