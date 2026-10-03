import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WelcomeTypewriter } from "../WelcomeTypewriter";
import {
  welcomeTypingSchedule,
  welcomePlaceholderDelay,
} from "../welcomeTyping";

const motion = vi.hoisted(() => ({
  reduced: false,
  load: vi.fn(),
  revert: vi.fn(),
  timelines: [] as Array<{
    kill: ReturnType<typeof vi.fn>;
    to: ReturnType<typeof vi.fn>;
    call: ReturnType<typeof vi.fn>;
  }>,
}));
vi.mock("../../../shared/design/motion", () => ({
  reducedMotion: () => motion.reduced,
  loadMotion: motion.load,
}));

beforeEach(() => {
  vi.clearAllMocks();
  motion.reduced = false;
  motion.timelines = [];
  motion.load.mockResolvedValue({
    context: (run: () => void) => {
      run();
      return { revert: motion.revert };
    },
    timeline: () => {
      const timeline = {
        kill: vi.fn(),
        pause: vi.fn(),
        resume: vi.fn(),
        to: vi.fn().mockReturnThis(),
        call: vi.fn().mockReturnThis(),
      };
      motion.timelines.push(timeline);
      return timeline;
    },
  });
});
afterEach(() => vi.restoreAllMocks());
const flush = () =>
  act(async () => {
    await Promise.resolve();
  });

describe("welcome typing rhythm", () => {
  it("preserves graphemes and uses deterministic varied timing with punctuation pauses", () => {
    const schedule = welcomeTypingSchedule("从一念，到万千可能。");
    expect(schedule.characters.join("")).toBe("从一念，到万千可能。");
    expect(schedule.at[4] - schedule.at[3]).toBeCloseTo(0.35);
    expect(schedule.at[1] - schedule.at[0]).not.toBe(
      schedule.at[2] - schedule.at[1],
    );
    expect(welcomeTypingSchedule("👩🏽‍💻e\u0301").characters).toHaveLength(2);
    expect(welcomePlaceholderDelay("从一念，到万千可能。")).toBeCloseTo(
      0.2 + schedule.duration + 0.6,
    );
  });
});

describe("welcome typewriter lifecycle", () => {
  it("keeps a complete accessible label while only the visual copy animates", async () => {
    const { container } = render(
      <h2>
        <WelcomeTypewriter text="从一念，到万千可能。" />
      </h2>,
    );
    expect(screen.getByRole("heading")).toHaveAccessibleName(
      "从一念，到万千可能。",
    );
    expect(
      container.querySelector("[data-welcome-typewriter]"),
    ).toHaveAttribute("aria-hidden", "true");
    await flush();
    expect(motion.timelines[0].to).toHaveBeenCalledTimes(10);
  });

  it("finishes on input and does not restart after the input is cleared", async () => {
    const { container, rerender } = render(
      <WelcomeTypewriter text="输入提示" />,
    );
    await flush();
    expect(
      container.querySelector("[data-welcome-typewriter]"),
    ).toHaveAttribute("data-typing", "true");
    rerender(<WelcomeTypewriter text="输入提示" finish />);
    await flush();
    expect(
      container.querySelector("[data-welcome-typewriter]"),
    ).not.toHaveAttribute("data-typing");
    rerender(<WelcomeTypewriter text="输入提示" finish={false} />);
    await flush();
    expect(motion.timelines).toHaveLength(1);
    expect(motion.revert).toHaveBeenCalled();
  });

  it("uses the new mode text without keeping stale characters", async () => {
    const { container, rerender } = render(
      <WelcomeTypewriter text="普通提示" />,
    );
    await flush();
    rerender(<WelcomeTypewriter text="目标提示" />);
    await flush();
    expect(
      container.querySelector("[data-welcome-typewriter]"),
    ).toHaveTextContent("目标提示");
    expect(motion.revert).toHaveBeenCalled();
    expect(motion.timelines).toHaveLength(2);
  });

  it("shows static text without loading GSAP for reduced motion", async () => {
    motion.reduced = true;
    const { container } = render(<WelcomeTypewriter text="完整提示" />);
    await flush();
    expect(motion.load).not.toHaveBeenCalled();
    expect(
      container.querySelector("[data-welcome-typewriter]"),
    ).not.toHaveAttribute("data-typing");
  });

  it("reveals full text immediately when reduced motion is enabled during typing", async () => {
    const media = Object.assign(new EventTarget(), { matches: false });
    vi.spyOn(window, "matchMedia").mockReturnValue(media as MediaQueryList);
    const { container } = render(<WelcomeTypewriter text="完整提示" />);
    await flush();
    media.matches = true;
    act(() => media.dispatchEvent(new Event("change")));
    expect(
      container.querySelector("[data-welcome-typewriter]"),
    ).not.toHaveAttribute("data-typing");
    expect(motion.revert).toHaveBeenCalled();
  });

  it("does not create a late animation after unmount", async () => {
    let resolve!: (value: unknown) => void;
    motion.load.mockReturnValue(
      new Promise((r) => {
        resolve = r;
      }),
    );
    const { unmount } = render(<WelcomeTypewriter text="提示" />);
    unmount();
    const context = vi.fn();
    await act(async () => resolve({ context }));
    expect(context).not.toHaveBeenCalled();
  });

  it("fails open to readable text if motion cannot load", async () => {
    motion.load.mockRejectedValue(new Error("offline chunk"));
    const { container } = render(<WelcomeTypewriter text="完整提示" />);
    await flush();
    expect(
      container.querySelector("[data-welcome-typewriter]"),
    ).not.toHaveAttribute("data-typing");
  });
});
