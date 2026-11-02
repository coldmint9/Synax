import { act, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useShellStore } from "../../shared/state/shellStore";
import { HomeGreeting } from "./HomeGreeting";
import type { GreetingPlugin } from "./greetingPlugin";

// The typewriter then renders its finished text instead of scheduling GSAP.
vi.mock("../../shared/design/motion", () => ({ reducedMotion: () => true }));

const heading = () => screen.getByRole("heading", { level: 1 });

beforeEach(() => {
  const initial = useShellStore.getInitialState();
  useShellStore.setState({ ...initial, preferences: { ...initial.preferences, locale: "zh" } });
  vi.useFakeTimers();
  vi.setSystemTime(new Date(2026, 0, 15, 9, 24));
});

afterEach(() => {
  vi.useRealTimers();
  useShellStore.setState(useShellStore.getInitialState());
});

describe("home greeting", () => {

  it("greets without a name because the kernel has no account provider", () => {
    render(<HomeGreeting />);
    expect(heading()).toHaveTextContent("上午好。状态最好，先啃最难的那件。");
    expect(heading()).not.toHaveTextContent("，。");
  });

  it("moves to the next phase when the clock crosses a boundary", () => {
    vi.setSystemTime(new Date(2026, 0, 15, 7, 59));
    render(<HomeGreeting />);
    expect(heading()).toHaveTextContent("清晨好。先挑一件小事启动今天。");

    act(() => {
      vi.advanceTimersByTime(60_000);
    });

    expect(heading()).toHaveTextContent("上午好。状态最好，先啃最难的那件。");
  });

  it("keeps the plugin slot out of the layout while nothing is registered", () => {
    const { container } = render(<HomeGreeting />);
    expect(container.querySelector("[data-greeting-plugin]")).toBeNull();
  });

  it("hands a registered plugin the greeting context", () => {
    const seen: string[] = [];
    const reminder: GreetingPlugin = {
      id: "smart-reminder",
      render: (context) => {
        seen.push(`${context.phase}/${context.name}/${context.locale}`);
        return <p>3 个会话停在昨晚 21:40</p>;
      },
    };
    const { container } = render(<HomeGreeting plugins={[reminder]} />);
    expect(screen.getByText("3 个会话停在昨晚 21:40")).toBeInTheDocument();
    expect(container.querySelector('[data-greeting-plugin="smart-reminder"]')).not.toBeNull();
    expect(seen).toEqual(["morning/null/zh"]);
  });

  it("skips a plugin that reports itself unavailable", () => {
    const hidden: GreetingPlugin = {
      id: "hidden",
      available: () => false,
      render: () => <p>不可用</p>,
    };
    render(<HomeGreeting plugins={[hidden]} />);
    expect(screen.queryByText("不可用")).toBeNull();
  });
});
