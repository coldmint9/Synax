import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import postcss from "postcss";
import { ComposerIsland } from "../ComposerIsland";
import css from "../agentControls.css?raw";
import shellCss from "../../../../index.css?raw";

let frames: Map<number, FrameRequestCallback>;
beforeEach(() => {
  frames = new Map();
  let id = 0;
  vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => {
    frames.set(++id, cb);
    return id;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
});
afterEach(() => vi.unstubAllGlobals());
function frame() {
  act(() => {
    const callbacks = [...frames.values()];
    frames.clear();
    callbacks.forEach((cb) => cb(0));
  });
}
function Island({ sessionId = "a", running = false, reading = false }) {
  return (
    <ComposerIsland
      sessionId={sessionId}
      running={running}
      readingHistory={reading}
      protectedInteraction={false}
      onStop={() => {}}
    >
      <textarea aria-label="Draft" />
    </ComposerIsland>
  );
}

describe("composer island transitions", () => {
  it("keeps the same nodes and disables transitions during rapid A → B → A switches", () => {
    const view = render(<Island />);
    const host = view.container.querySelector(".session-composer-island");
    const input = screen.getByRole("textbox");
    expect(host).toHaveClass(
      "animate-in",
      "fade-in-0",
      "zoom-in-95",
      "motion-reduce:animate-none",
    );
    frame();
    frame();
    expect(host).not.toHaveAttribute("data-switching");
    view.rerender(<Island sessionId="b" />);
    expect(host).toHaveAttribute("data-switching", "true");
    expect(host).not.toHaveClass("animate-in");
    view.rerender(<Island sessionId="a" />);
    expect(host).toHaveAttribute("data-switching", "true");
    expect(screen.getByRole("textbox")).toBe(input);
    expect(view.container.querySelector(".session-composer-island")).toBe(host);
    frame();
    frame();
    expect(host).not.toHaveAttribute("data-switching");
  });

  it("preserves running/history collapse and manual expansion within a session", () => {
    const view = render(<Island running reading />);
    const host = view.container.querySelector(".session-composer-island");
    expect(host).toHaveAttribute("data-collapsed", "true");
    frame();
    frame();
    fireEvent.click(
      view.container.querySelector(".session-composer-island-expand")!,
    );
    expect(host).toHaveAttribute("data-collapsed", "false");
    view.rerender(<Island sessionId="b" running={false} reading={false} />);
    expect(host).toHaveAttribute("data-collapsed", "false");
  });

  it("keeps centering transforms identical before measurement and disables lateral rail transitions", () => {
    const root = postcss.parse(css);
    const values: Record<string, Record<string, string>> = {};
    root.walkRules((rule) => {
      const declarations: Record<string, string> = {};
      rule.walkDecls((d) => {
        declarations[d.prop] = d.value;
      });
      values[rule.selector.replace(/\s+/g, " ")] = declarations;
    });
    expect(values[".session-composer-island-content"].transform).toBe(
      "translateX(-50%)",
    );
    expect(
      values[
        '.session-composer-island-frame[data-measured="true"] > .session-composer-island-content'
      ].transform,
    ).toBe("translateX(-50%)");
    const switching = Object.entries(values).find(([selector]) =>
      selector.startsWith('.session-composer-island[data-switching="true"]'),
    );
    expect(switching?.[1].transition).toBe("none");
    postcss.parse(shellCss).walkRules((rule) => {
      if (rule.selector === ".agent-command-rail")
        rule.walkDecls("transition", (decl) => {
          expect(decl.value).not.toMatch(/left|right/);
        });
    });
  });
});
