import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useShellStore } from "../../../state/shellStore";
import { ThinkingBlock } from "../ThinkingBlock";

/**
 * Regression guard for the transcript render cost: a collapsed reasoning row
 * must not keep its text in the DOM, otherwise a session with dozens of large
 * reasoning blocks pays for all of them on every render.
 */
describe("ThinkingBlock", () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    useShellStore.setState((state) => ({
      preferences: { ...state.preferences, locale: "en" },
    }));
  });

  it("keeps the reasoning body out of the DOM until expanded", () => {
    const content = `reasoning-${"x".repeat(20_000)}`;
    const { container } = render(<ThinkingBlock content={content} />);

    expect(container.querySelector("[data-activity-body]")).toBeNull();
    // The compact title exposes a bounded tail preview without mounting the
    // body: the row reports where the reasoning ended, not where it started.
    const title = screen.getByRole("button").getAttribute("title") ?? "";
    expect(title.startsWith("…")).toBe(true);
    expect(title.length).toBeLessThanOrEqual(401);
    expect(title).not.toContain("reasoning-");
    expect((container.textContent ?? "").length).toBeLessThan(300);
  });

  it("previews the newest reasoning line on a collapsed row", () => {
    render(
      <ThinkingBlock
        content={"first line of reasoning\n\nlatest line of reasoning"}
      />,
    );

    expect(screen.getByRole("button").getAttribute("title")).toBe(
      "latest line of reasoning",
    );
  });

  it("mounts the body on expand and releases it after the closing transition", () => {
    vi.useFakeTimers();
    const { container } = render(
      <ThinkingBlock content="step one reasoning" />,
    );
    const header = screen.getByRole("button");

    fireEvent.click(header);
    expect(
      container.querySelector("[data-activity-body]")?.textContent,
    ).toContain("step one reasoning");

    fireEvent.click(header);
    expect(header).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelector(".bui-thinking-reveal")).toHaveAttribute(
      "inert",
    );
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(container.querySelector("[data-activity-body]")).toBeNull();
  });

  it("reports the character count for a collapsed row", () => {
    render(<ThinkingBlock content={"x".repeat(7_240)} />);
    expect(screen.getByText("7.2k chars")).toBeTruthy();
  });

  it.each(["", " \n\t", ".", "..", "...", "……"])(
    "hides placeholder %j in both streaming and completed views",
    (content) => {
      const { container, rerender } = render(
        <ThinkingBlock content={content} isStreaming />,
      );
      expect(container).toBeEmptyDOMElement();
      rerender(<ThinkingBlock content={content} />);
      expect(container).toBeEmptyDOMElement();
    },
  );

  it("reveals a real short thought immediately after a placeholder prefix", () => {
    const { container, rerender } = render(
      <ThinkingBlock content="..." isStreaming />,
    );
    expect(container).toBeEmptyDOMElement();
    rerender(<ThinkingBlock content="...嗯" isStreaming />);
    expect(container.querySelector("[data-activity-body]")).toHaveTextContent(
      "...嗯",
    );
    rerender(<ThinkingBlock content="嗯" />);
    expect(screen.getByText("1 chars")).toBeTruthy();
  });

  it("renders a streaming row expanded and scrollable", () => {
    vi.useFakeTimers();
    const { container } = render(
      <ThinkingBlock content="live reasoning" isStreaming />,
    );
    // No local typing interval: the body renders the stream buffer as-is.
    expect(vi.getTimerCount()).toBe(0);
    expect(
      container.querySelector("[data-activity-body]")?.textContent,
    ).toContain("live reasoning");
  });

  it("shows each delta at the rate the backend emits it instead of re-typing it locally", () => {
    vi.useFakeTimers();
    const { container, rerender, unmount } = render(
      <ThinkingBlock content="你" isStreaming />,
    );
    const body = () =>
      container.querySelector("[data-activity-body]")?.textContent;

    // Every appended delta lands immediately: no interval gates the reveal, so
    // the visible text already ends where the stream ends.
    expect(body()).toBe("你");
    rerender(<ThinkingBlock content="你好" isStreaming />);
    expect(body()).toBe("你好");
    rerender(<ThinkingBlock content="你好😀" isStreaming />);
    expect(body()).toBe("你好😀");
    // Completion keeps the last streamed text, emoji intact, and the collapsed
    // row can still be reopened to read it.
    rerender(<ThinkingBlock content="你好😀完成" isStreaming={false} />);
    // The only pending timer is the closing transition that releases the body;
    // nothing paces the text itself.
    expect(vi.getTimerCount()).toBe(1);
    act(() => {
      screen.getByRole("button").click();
    });
    expect(body()).toBe("你好😀完成");
    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("only renders the tail of an oversized body when expanded", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <ThinkingBlock content={`${"a".repeat(9_000)}TAILMARK`} />,
    );

    await user.click(screen.getByRole("button"));
    const body =
      container.querySelector("[data-activity-body]")?.textContent ?? "";
    expect(body).toContain("TAILMARK");
    expect(body).toContain("Hidden");
  });

  it("renders a headline-only block as a banner without the markdown markers", () => {
    const { container } = render(
      <ThinkingBlock content="**Inspecting backend metadata**" />,
    );

    expect(container.querySelector(".bui-thinking-banner")).not.toBeNull();
    expect(
      container.querySelector(".bui-thinking-banner-text")?.textContent,
    ).toBe("Inspecting backend metadata");
    expect(container.textContent).not.toContain("**");
    // No row body: there is nothing under the headline to expand.
    expect(container.querySelector("[data-activity-body]")).toBeNull();
    expect(screen.queryByRole("button")).toBeNull();
  });

  it("marks a streaming banner live so the sweep reads as in-progress", () => {
    const { container } = render(
      <ThinkingBlock content="**Inspecting backend metadata**" isStreaming />,
    );
    expect(
      container
        .querySelector(".bui-thinking-banner")
        ?.getAttribute("data-live"),
    ).toBe("true");
  });

  it("splits adjacent headlines into a carousel and follows newly streamed chunks", async () => {
    const user = userEvent.setup();
    const { container, rerender } = render(
      <ThinkingBlock
        content="**Designing layout****Planning animation**"
        isStreaming
      />,
    );

    expect(
      container.querySelector(".bui-thinking-banner-text"),
    ).toHaveTextContent("Planning animation");
    expect(
      container.querySelector(".bui-thinking-banner-position"),
    ).toHaveTextContent("2/2");

    await user.click(screen.getByRole("button", { name: "Previous thought" }));
    expect(
      container.querySelector(".bui-thinking-banner-text"),
    ).toHaveTextContent("Designing layout");
    expect(
      container.querySelector(".bui-thinking-banner-position"),
    ).toHaveTextContent("1/2");

    rerender(
      <ThinkingBlock
        content="**Designing layout****Planning animation****Verifying output**"
        isStreaming
      />,
    );
    expect(
      container.querySelector(".bui-thinking-banner-text"),
    ).toHaveTextContent("Verifying output");
    expect(
      container.querySelector(".bui-thinking-banner-position"),
    ).toHaveTextContent("3/3");
  });

  it("keeps paragraph reasoning on the expandable row", () => {
    const { container } = render(
      <ThinkingBlock content="**Bold** plus a real reasoning paragraph." />,
    );
    expect(container.querySelector(".bui-thinking-banner")).toBeNull();
    expect(screen.getByRole("button")).toBeTruthy();
  });

  it("collapses on completion and can be reopened", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(
      <ThinkingBlock content="live reasoning" isStreaming />,
    );
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "true");
    rerender(
      <ThinkingBlock content="finished reasoning" isStreaming={false} />,
    );
    expect(screen.getByRole("button")).toHaveAttribute(
      "aria-expanded",
      "false",
    );
    act(() => {
      vi.advanceTimersByTime(400);
    });
    expect(container.querySelector("[data-activity-body]")).toBeNull();
    fireEvent.click(screen.getByRole("button"));
    expect(container.querySelector("[data-activity-body]")).toHaveTextContent(
      "finished reasoning",
    );
  });

  it("retains manual expansion after completion and remount", () => {
    const { rerender, unmount } = render(
      <ThinkingBlock
        content="reasoning"
        isStreaming
        rememberKey="manual-trace-test"
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    fireEvent.click(screen.getByRole("button"));
    rerender(
      <ThinkingBlock
        content="finished reasoning"
        rememberKey="manual-trace-test"
      />,
    );
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "true");
    unmount();
    render(
      <ThinkingBlock
        content="finished reasoning"
        rememberKey="manual-trace-test"
      />,
    );
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "true");
  });
});
