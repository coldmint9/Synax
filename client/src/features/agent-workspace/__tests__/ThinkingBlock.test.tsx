import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useShellStore } from "../../../shared/state/shellStore";
import { ThinkingBlock } from "../ThinkingBlock";

describe("ThinkingBlock", () => {
  afterEach(() => vi.useRealTimers());
  beforeEach(() => {
    useShellStore.setState((state) => ({ preferences: { ...state.preferences, locale: "en", sessionShowThinking: true } }));
  });

  it.each([false, true])("keeps large bodies unmounted by default, streaming=%s", (isStreaming) => {
    const content = "reasoning-" + "x".repeat(20_000);
    const { container } = render(<ThinkingBlock content={content} isStreaming={isStreaming} />);
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "false");
    expect(container.querySelector("[data-activity-body]")).toBeNull();
    expect(container.querySelector(".bui-thinking-preview")).toHaveTextContent("reasoning-");
    expect((container.textContent ?? "").length).toBeLessThan(300);
    expect(screen.getByRole("button").getAttribute("title")!.length).toBeLessThanOrEqual(400);
  });

  it("keeps the opening preview stable as later reasoning arrives", () => {
    const { container, rerender } = render(<ThinkingBlock content="Inspect the submit handler." isStreaming />);
    const header = screen.getByRole("button");
    rerender(<ThinkingBlock content={"Inspect the submit handler.\n\nNow check the disabled state."} isStreaming />);
    expect(screen.getByRole("button")).toBe(header);
    expect(container.querySelector(".bui-thinking-preview")).toHaveTextContent("Inspect the submit handler.");
    expect(container.querySelector(".bui-thinking-preview")).not.toHaveTextContent("Now check");
    expect(header).toHaveAttribute("aria-expanded", "false");
  });

  it.each(["visible thought", "**Thinking headline**"])("respects the show-thinking preference for %s", (content) => {
    const { container } = render(<ThinkingBlock content={content} isStreaming />);
    act(() => useShellStore.getState().setSessionShowThinking(false));
    expect(container).toBeEmptyDOMElement();
    act(() => useShellStore.getState().setSessionShowThinking(true));
    expect(container).toHaveTextContent(content.replaceAll("**", ""));
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "false");
  });

  it("mounts on keyboard activation and releases the inert body after closing", async () => {
    const user = userEvent.setup();
    const { container } = render(<ThinkingBlock content="step one reasoning" />);
    await user.tab();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("button")).toHaveFocus();
    expect(container.querySelector("[data-activity-body]")).toHaveTextContent("step one reasoning");
    fireEvent.click(screen.getByRole("button"));
    expect(container.querySelector(".bui-thinking-reveal")).toHaveAttribute("inert");
    await waitFor(() => expect(container.querySelector("[data-activity-body]")).toBeNull());
  });

  it("expands the preview into one continuous body without rendering the opening twice", async () => {
    const opening = "updatedAt comes from header.updatedAt.";
    const content = opening + "\n\nSo on startup, the values are historical.";
    const { container, rerender } = render(<ThinkingBlock content={content} isStreaming />);
    const header = screen.getByRole("button");
    expect(container.querySelector(".bui-thinking-preview")).toHaveTextContent(opening);

    fireEvent.click(header);
    expect(container.querySelector(".bui-thinking-preview")).toBeNull();
    expect(container.querySelector(".bui-thinking-prose")?.textContent).toBe(content);
    expect(container.textContent?.split(opening)).toHaveLength(2);
    const body = container.querySelector("[data-activity-body]") as HTMLDivElement;
    expect(body.scrollTop).toBe(0);
    body.scrollTop = 20;

    rerender(<ThinkingBlock content={content + " Continue checking the timestamps."} isStreaming />);
    expect(container.querySelector(".bui-thinking-preview")).toBeNull();
    expect(container.textContent?.split(opening)).toHaveLength(2);
    expect(body.scrollTop).toBe(20);

    fireEvent.click(header);
    expect(container.querySelector(".bui-thinking-preview")).toHaveTextContent(opening);
    await waitFor(() => expect(container.querySelector("[data-activity-body]")).toBeNull());
    expect(container.textContent?.split(opening)).toHaveLength(2);
  });

  it("reports the size without mounting the reasoning", () => {
    render(<ThinkingBlock content={"x".repeat(7_240)} />);
    expect(screen.getByText("7.2k chars")).toBeTruthy();
  });

  it.each(["", " \n\t", ".", "..", "...", "……"])("hides placeholder %j", (content) => {
    const { container, rerender } = render(<ThinkingBlock content={content} isStreaming />);
    expect(container).toBeEmptyDOMElement();
    rerender(<ThinkingBlock content={content} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("previews short real deltas immediately without expanding or local typing timers", () => {
    vi.useFakeTimers();
    const { container, rerender } = render(<ThinkingBlock content="..." isStreaming />);
    for (const content of ["你", "你好", "你好😀", "你好😀完成"]) {
      rerender(<ThinkingBlock content={content} isStreaming />);
      expect(container.querySelector(".bui-thinking-preview")).toHaveTextContent(content);
      expect(container.querySelector("[data-activity-body]")).toBeNull();
      expect(vi.getTimerCount()).toBe(0);
    }
  });

  it("shows the bounded tail when an oversized body is explicitly expanded", () => {
    const { container } = render(<ThinkingBlock content={"a".repeat(9_000) + "TAILMARK"} />);
    fireEvent.click(screen.getByRole("button"));
    const body = container.querySelector("[data-activity-body]")?.textContent ?? "";
    expect(body).toContain("TAILMARK");
    expect(body).toContain("Hidden");
    expect(body.length).toBeLessThan(8_200);
  });

  it("renders headline reasoning in the same row and preserves every headline on expand", () => {
    const { container } = render(<ThinkingBlock content="**Designing layout****Planning animation**" isStreaming />);
    expect(container.querySelector(".bui-thinking-banner")).toBeNull();
    expect(container.querySelector(".bui-thinking-preview")).toHaveTextContent("Designing layout");
    expect(container.textContent).not.toContain("**");
    fireEvent.click(screen.getByRole("button"));
    expect(container.querySelector("[data-activity-body]")).toHaveTextContent("Designing layout Planning animation");
  });

  it("does not change expansion when streaming finishes", () => {
    const { container, rerender } = render(<ThinkingBlock content="live reasoning" isStreaming />);
    rerender(<ThinkingBlock content="finished reasoning" />);
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(screen.getByRole("button"));
    rerender(<ThinkingBlock content="finished reasoning with a late update" />);
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "true");
    expect(container.querySelector("[data-activity-body]")).toHaveTextContent("late update");
  });

  it("retains manual expansion after completion and virtualization remount", () => {
    const { rerender, unmount } = render(<ThinkingBlock content="reasoning" isStreaming rememberKey="manual-trace-test" />);
    fireEvent.click(screen.getByRole("button"));
    rerender(<ThinkingBlock content="finished reasoning" rememberKey="manual-trace-test" />);
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "true");
    unmount();
    render(<ThinkingBlock content="finished reasoning" rememberKey="manual-trace-test" />);
    expect(screen.getByRole("button")).toHaveAttribute("aria-expanded", "true");
  });
});
