import { act, fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, afterEach, describe, expect, it, vi } from "vitest";
import { NewSessionScene } from "../NewSessionScene";

const motion = vi.hoisted(() => ({
  reduced: false,
  load: vi.fn(),
  revert: vi.fn(),
  quickTo: vi.fn(),
  set: vi.fn(),
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
  vi.spyOn(window, "matchMedia").mockImplementation(
    (query) =>
      (query.includes("reduced-motion")
        ? reduce
        : {
            matches: true,
            addEventListener: vi.fn(),
            removeEventListener: vi.fn(),
          }) as MediaQueryList,
  );
  motion.quickTo.mockImplementation(() =>
    Object.assign(vi.fn(), { tween: { kill: vi.fn() } }),
  );
  motion.load.mockResolvedValue({
    context: (run: () => void) => {
      run();
      return { revert: motion.revert };
    },
    fromTo: vi.fn(),
    quickTo: motion.quickTo,
    set: motion.set,
  });
});
afterEach(() => vi.restoreAllMocks());
const flush = () =>
  act(async () => {
    await Promise.resolve();
  });
function Scene({ paused = false }: { paused?: boolean }) {
  return (
    <NewSessionScene paused={paused}>
      <div data-welcome-layer="mark" />
      <h2 data-welcome-layer="title">Welcome</h2>
      <button aria-haspopup="listbox" aria-expanded="false">
        Models
      </button>
      <div data-welcome-layer="composer">
        <textarea aria-label="Message" />
      </div>
    </NewSessionScene>
  );
}
function move(container: HTMLElement, type = "mouse") {
  const scene = container.firstElementChild!;
  vi.spyOn(scene, "getBoundingClientRect").mockReturnValue({
    left: 0,
    top: 0,
    width: 100,
    height: 100,
  } as DOMRect);
  fireEvent(
    scene,
    new PointerEvent("pointermove", {
      clientX: 100,
      clientY: 100,
      pointerType: type,
    }),
  );
}

describe("welcome scene motion", () => {
  it("moves three layers by distinct bounded distances and resets on leave", async () => {
    const { container, unmount } = render(<Scene />);
    await flush();
    move(container);
    expect(
      motion.quickTo.mock.results.map(
        (result) => result.value.mock.lastCall?.[0],
      ),
    ).toEqual([6, 6, 4, 4, 2, 2]);
    fireEvent.pointerLeave(container.firstElementChild!);
    expect(
      motion.quickTo.mock.results.every(
        (result) => result.value.mock.lastCall[0] === 0,
      ),
    ).toBe(true);
    unmount();
    expect(motion.revert).toHaveBeenCalled();
    expect(
      motion.quickTo.mock.results.every(
        (result) => result.value.tween.kill.mock.calls.length > 0,
      ),
    ).toBe(true);
  });

  it("ignores touch, focused editing, and open overlays", async () => {
    const { container, rerender } = render(<Scene />);
    await flush();
    move(container, "touch");
    expect(motion.quickTo.mock.results[0].value).not.toHaveBeenCalled();
    screen.getByRole("textbox").focus();
    move(container);
    expect(motion.quickTo.mock.results[0].value).toHaveBeenLastCalledWith(0);
    screen.getByRole("textbox").blur();
    rerender(<Scene paused />);
    move(container);
    expect(motion.quickTo.mock.results[0].value).toHaveBeenLastCalledWith(0);
  });

  it("blocks parallax for a portaled menu even when it does not report overlay state", async () => {
    const { container } = render(<Scene />);
    await flush();
    screen
      .getByRole("button", { name: "Models" })
      .setAttribute("aria-expanded", "true");
    move(container);
    expect(motion.quickTo.mock.results[0].value).not.toHaveBeenCalled();
  });

  it("clears transforms when reduced motion is enabled without reviving killed tweens", async () => {
    const { container } = render(<Scene />);
    await flush();
    move(container);
    reduce.matches = true;
    act(() => reduce.dispatchEvent(new Event("change")));
    expect(motion.revert).toHaveBeenCalled();
    const count = motion.quickTo.mock.results[0].value.mock.calls.length;
    fireEvent.pointerLeave(container.firstElementChild!);
    move(container);
    expect(motion.quickTo.mock.results[0].value).toHaveBeenCalledTimes(count);
  });

  it("does not load animations under reduced motion", async () => {
    motion.reduced = true;
    render(<Scene />);
    await flush();
    expect(motion.load).not.toHaveBeenCalled();
  });
});
