import { act, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it } from "vitest";
import { useTabKeyBehavior } from "../useTabKeyBehavior";

const INDENT = "    ";

function Harness() {
  useTabKeyBehavior();
  const [value, setValue] = useState("");
  return (
    <div>
      <input
        aria-label="target-input"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <textarea
        aria-label="target-area"
        value={value}
        onChange={(e) => setValue(e.target.value)}
      />
      <button type="button">elsewhere</button>
      <div className="xterm">
        <textarea className="xterm-helper-textarea" aria-label="terminal" />
      </div>
    </div>
  );
}

function pressTab(
  init: Partial<KeyboardEventInit> = {},
  target?: Element,
): KeyboardEvent {
  const event = new KeyboardEvent("keydown", {
    key: "Tab",
    bubbles: true,
    cancelable: true,
    ...init,
  });
  (target ?? document.activeElement ?? document.body).dispatchEvent(event);
  return event;
}

describe("useTabKeyBehavior", () => {
  it("inserts four spaces into a focused input instead of moving focus", () => {
    render(<Harness />);
    const input = screen.getByLabelText("target-input") as HTMLInputElement;
    input.focus();
    let event: KeyboardEvent;
    act(() => {
      event = pressTab({}, input);
    });
    expect(event!.defaultPrevented).toBe(true);
    expect(input.value).toBe(INDENT);
  });

  it("inserts at the cursor of a textarea", () => {
    render(<Harness />);
    const area = screen.getByLabelText("target-area") as HTMLTextAreaElement;
    area.focus();
    act(() => {
      pressTab({}, area);
    });
    expect(area.value).toBe(INDENT);
  });

  it("blocks Tab focus navigation on non-editable elements", () => {
    render(<Harness />);
    const button = screen.getByRole("button");
    button.focus();
    let event: KeyboardEvent;
    act(() => {
      event = pressTab({}, button);
    });
    expect(event!.defaultPrevented).toBe(true);
    expect(document.activeElement).toBe(button);
  });

  it("still blocks focus movement on Shift+Tab but inserts nothing", () => {
    render(<Harness />);
    const input = screen.getByLabelText("target-input") as HTMLInputElement;
    input.focus();
    let event: KeyboardEvent;
    act(() => {
      event = pressTab({ shiftKey: true }, input);
    });
    expect(event!.defaultPrevented).toBe(true);
    expect(input.value).toBe("");
  });

  it("leaves the xterm helper textarea alone for shell completion", () => {
    render(<Harness />);
    const terminal = screen.getByLabelText("terminal");
    terminal.focus();
    let event: KeyboardEvent;
    act(() => {
      event = pressTab({}, terminal);
    });
    expect(event!.defaultPrevented).toBe(false);
  });

  it("ignores Tab with ctrl/meta modifiers", () => {
    render(<Harness />);
    const input = screen.getByLabelText("target-input") as HTMLInputElement;
    input.focus();
    let event: KeyboardEvent;
    act(() => {
      event = pressTab({ ctrlKey: true }, input);
    });
    expect(event!.defaultPrevented).toBe(false);
    expect(input.value).toBe("");
  });

  it("ignores IME composition keydowns", () => {
    render(<Harness />);
    const input = screen.getByLabelText("target-input") as HTMLInputElement;
    input.focus();
    let event: KeyboardEvent;
    act(() => {
      event = pressTab({ isComposing: true }, input);
    });
    expect(event!.defaultPrevented).toBe(false);
    expect(input.value).toBe("");
  });
});
