import { useState, type FormEvent } from "react";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AccentColorPicker } from "../AccentColorPicker";

function ControlledPicker({
  initial = "#ff0000",
  onChange = (_value: string) => {},
}) {
  const [value, setValue] = useState(initial);
  return (
    <>
      <AccentColorPicker
        value={value}
        locale="en"
        onChange={(next) => {
          setValue(next);
          onChange(next);
        }}
      />
      <button type="button">Outside</button>
    </>
  );
}

async function openPicker(initial?: string) {
  const onChange = vi.fn();
  const user = userEvent.setup();
  render(<ControlledPicker initial={initial} onChange={onChange} />);
  const trigger = screen.getByRole("button", { name: "Custom accent color" });
  await user.click(trigger);
  return {
    user,
    onChange,
    trigger,
    hex: screen.getByRole("textbox", { name: "HEX color" }),
  };
}

function mockArea() {
  const area = screen.getByRole("group", { name: "Saturation and brightness" });
  vi.spyOn(area, "getBoundingClientRect").mockReturnValue(
    new DOMRect(10, 20, 200, 100),
  );
  const setPointerCapture = vi.fn();
  const releasePointerCapture = vi.fn();
  Object.defineProperties(area, {
    setPointerCapture: { configurable: true, value: setPointerCapture },
    hasPointerCapture: { configurable: true, value: () => true },
    releasePointerCapture: { configurable: true, value: releasePointerCapture },
  });
  return { area, setPointerCapture, releasePointerCapture };
}

const pointer = {
  pointerId: 7,
  pointerType: "mouse",
  isPrimary: true,
  button: 0,
};

afterEach(() => vi.restoreAllMocks());

describe("AccentColorPicker", () => {
  it("labels the 2D area, native keyboard channel controls and HEX field", async () => {
    const { hex } = await openPicker();
    expect(
      screen.getByRole("dialog", { name: "Custom accent color" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("group", { name: "Saturation and brightness" }),
    ).toHaveAccessibleDescription(/drag.*saturation.*brightness/i);
    for (const name of ["Hue", "Saturation", "Brightness"]) {
      const slider = screen.getByRole("slider", { name });
      expect(slider).toHaveAttribute("type", "range");
      expect(slider).toHaveAccessibleDescription(/arrow keys/i);
    }
    expect(hex).toHaveAccessibleDescription(/3 or 6/i);
    expect(hex).toHaveValue("#FF0000");
  });

  it.each([
    ["rgb(51 102 153)", "#336699"],
    ["hsl(210 50% 40%)", "#336699"],
  ])("uses HEX editor state without replacing an imported CSS preview", async (cssColor, expectedHex) => {
    await openPicker(cssColor);

    expect(screen.getByRole("textbox", { name: "HEX color" })).toHaveValue(expectedHex.toUpperCase());
    expect(screen.getByRole("button", { name: "Custom accent color" })).toHaveTextContent(expectedHex.toUpperCase());
    expect(document.querySelector(".appearance-color-preview")).toHaveStyle({
      backgroundColor: cssColor,
    });
  });

  it("keeps partial drafts independent, and persists valid typing without rewriting the draft", async () => {
    const { user, onChange, hex } = await openPicker();
    await user.clear(hex);
    await user.type(hex, "#1a");
    expect(hex).toHaveValue("#1a");
    expect(onChange).not.toHaveBeenCalled();
    await user.type(hex, "2b3c");
    expect(hex).toHaveValue("#1a2b3c");
    expect(onChange).toHaveBeenLastCalledWith("#1a2b3c");
    await user.keyboard("{Enter}");
    expect(hex).toHaveValue("#1A2B3C");
    expect(hex).toHaveFocus();
    expect(hex).not.toHaveAttribute("aria-invalid", "true");
  });

  it("accepts short/no-hash HEX and normalizes only on commit", async () => {
    const { user, onChange, hex } = await openPicker();
    await user.clear(hex);
    await user.type(hex, "0Af");
    expect(hex).toHaveValue("0Af");
    expect(onChange).toHaveBeenLastCalledWith("#00aaff");
    await user.tab({ shift: true });
    expect(hex).toHaveValue("#00AAFF");
  });

  it("validates Enter and blur without persisting invalid text, then clears the error on correction", async () => {
    const { user, onChange, hex } = await openPicker();
    await user.clear(hex);
    await user.type(hex, "#nope{Enter}");
    expect(hex).toHaveFocus();
    expect(hex).toHaveValue("#nope");
    expect(hex).toHaveAttribute("aria-invalid", "true");
    expect(screen.getByRole("alert")).toHaveTextContent(/valid.*HEX/i);
    expect(hex).toHaveAccessibleDescription(/valid.*HEX/i);
    expect(onChange).not.toHaveBeenCalled();
    await user.clear(hex);
    await user.type(hex, "#12");
    fireEvent.blur(hex);
    expect(hex).toHaveAttribute("aria-invalid", "true");
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.change(hex, { target: { value: "#abcdef" } });
    expect(hex).not.toHaveAttribute("aria-invalid", "true");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(onChange).toHaveBeenLastCalledWith("#abcdef");
  });

  it("cancels an invalid draft with Escape, returns focus, and reopens with the last persisted color", async () => {
    const { user, onChange, trigger, hex } = await openPicker();
    await user.clear(hex);
    await user.type(hex, "#12{Escape}");
    await waitFor(() =>
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument(),
    );
    expect(trigger).toHaveFocus();
    expect(onChange).not.toHaveBeenCalled();
    await user.click(trigger);
    expect(screen.getByRole("textbox", { name: "HEX color" })).toHaveValue(
      "#FF0000",
    );
  });

  it("Escape discards only unfinished text, not a valid color already previewed", async () => {
    const { user, onChange, trigger, hex } = await openPicker();
    fireEvent.change(hex, { target: { value: "#abc123" } });
    expect(onChange).toHaveBeenLastCalledWith("#abc123");
    await user.clear(hex);
    await user.type(hex, "#1{Escape}");
    await user.click(trigger);
    expect(screen.getByRole("textbox", { name: "HEX color" })).toHaveValue(
      "#ABC123",
    );
    expect(onChange).toHaveBeenCalledTimes(1);
  });

  it("commits Enter without submitting an enclosing form or dropping keyboard focus", async () => {
    const user = userEvent.setup();
    const submit = vi.fn((event: FormEvent) => event.preventDefault());
    render(
      <form onSubmit={submit}>
        <ControlledPicker />
      </form>,
    );
    await user.click(
      screen.getByRole("button", { name: "Custom accent color" }),
    );
    const hex = screen.getByRole("textbox", { name: "HEX color" });
    await user.clear(hex);
    await user.type(hex, "abc{Enter}");
    expect(hex).toHaveValue("#AABBCC");
    expect(hex).toHaveFocus();
    expect(submit).not.toHaveBeenCalled();
  });

  it("closes via its close button and outside click, and restores trigger focus on explicit close", async () => {
    const { user, trigger } = await openPicker();
    await user.click(
      screen.getByRole("button", { name: "Close color editor" }),
    );
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "Outside" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Outside" })).toHaveFocus();
  });

  it("preserves hue and saturation at black, even across closing and reopening", async () => {
    const { user, trigger, onChange } = await openPicker("#0000ff");
    fireEvent.change(screen.getByRole("slider", { name: "Brightness" }), {
      target: { value: "0" },
    });
    expect(onChange).toHaveBeenLastCalledWith("#000000");
    fireEvent.change(screen.getByRole("slider", { name: "Hue" }), {
      target: { value: "210" },
    });
    expect(screen.getByRole("slider", { name: "Hue" })).toHaveValue("210");
    await user.click(
      screen.getByRole("button", { name: "Close color editor" }),
    );
    await user.click(trigger);
    expect(screen.getByRole("slider", { name: "Hue" })).toHaveValue("210");
    expect(screen.getByRole("slider", { name: "Saturation" })).toHaveValue(
      "100",
    );
    fireEvent.change(screen.getByRole("slider", { name: "Brightness" }), {
      target: { value: "100" },
    });
    expect(onChange).toHaveBeenLastCalledWith("#0080ff");
  });

  it("preserves the chosen hue at white and zero saturation, including HEX neutral edits", async () => {
    const { hex, onChange } = await openPicker("#0000ff");
    fireEvent.change(screen.getByRole("slider", { name: "Saturation" }), {
      target: { value: "0" },
    });
    expect(onChange).toHaveBeenLastCalledWith("#ffffff");
    fireEvent.change(screen.getByRole("slider", { name: "Hue" }), {
      target: { value: "120" },
    });
    fireEvent.change(hex, { target: { value: "#808080" } });
    expect(screen.getByRole("slider", { name: "Hue" })).toHaveValue("120");
    fireEvent.change(screen.getByRole("slider", { name: "Saturation" }), {
      target: { value: "100" },
    });
    expect(onChange).toHaveBeenLastCalledWith("#008000");
  });

  it("captures a drag, clamps all four edges, applies pointer-up and ignores hover/other pointers", async () => {
    const { onChange } = await openPicker();
    const { area, setPointerCapture, releasePointerCapture } = mockArea();
    fireEvent.pointerMove(area, { ...pointer, clientX: 100, clientY: 50 });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.pointerDown(area, { ...pointer, clientX: 110, clientY: 70 });
    expect(setPointerCapture).toHaveBeenCalledWith(7);
    expect(onChange).toHaveBeenLastCalledWith("#804040");
    onChange.mockClear();
    fireEvent.pointerMove(area, {
      ...pointer,
      pointerId: 8,
      clientX: 210,
      clientY: 20,
    });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.pointerMove(area, { ...pointer, clientX: -50, clientY: -50 });
    expect(onChange).toHaveBeenLastCalledWith("#ffffff");
    fireEvent.pointerMove(area, { ...pointer, clientX: 400, clientY: 200 });
    expect(onChange).toHaveBeenLastCalledWith("#000000");
    expect(screen.getByRole("slider", { name: "Saturation" })).toHaveValue(
      "100",
    );
    fireEvent.pointerUp(area, { ...pointer, clientX: 210, clientY: 20 });
    expect(onChange).toHaveBeenLastCalledWith("#ff0000");
    expect(releasePointerCapture).toHaveBeenCalledWith(7);
    onChange.mockClear();
    fireEvent.pointerMove(area, { ...pointer, clientX: 110, clientY: 70 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("ignores secondary input and zero-size geometry and ends cancelled/lost-capture drags", async () => {
    const { onChange } = await openPicker();
    const { area, releasePointerCapture } = mockArea();
    fireEvent.pointerDown(area, {
      ...pointer,
      button: 2,
      clientX: 110,
      clientY: 70,
    });
    fireEvent.pointerDown(area, {
      ...pointer,
      isPrimary: false,
      clientX: 110,
      clientY: 70,
    });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.pointerDown(area, { ...pointer, clientX: 110, clientY: 70 });
    fireEvent.pointerCancel(area, pointer);
    expect(releasePointerCapture).toHaveBeenCalledWith(7);
    onChange.mockClear();
    fireEvent.pointerMove(area, { ...pointer, clientX: 210, clientY: 20 });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.pointerDown(area, { ...pointer, clientX: 110, clientY: 70 });
    fireEvent.lostPointerCapture(area, pointer);
    onChange.mockClear();
    fireEvent.pointerMove(area, { ...pointer, clientX: 210, clientY: 20 });
    expect(onChange).not.toHaveBeenCalled();
    vi.mocked(area.getBoundingClientRect).mockReturnValue(
      new DOMRect(0, 0, 0, 0),
    );
    fireEvent.pointerDown(area, { ...pointer, clientX: 0, clientY: 0 });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("synchronizes controlled color changes and neutral colors retain the most recent external hue", async () => {
    const user = userEvent.setup();
    const change = vi.fn();
    const { rerender } = render(
      <AccentColorPicker value="#ff0000" locale="en" onChange={change} />,
    );
    await user.click(
      screen.getByRole("button", { name: "Custom accent color" }),
    );
    fireEvent.change(screen.getByRole("textbox", { name: "HEX color" }), {
      target: { value: "#12" },
    });
    rerender(
      <AccentColorPicker value="#0000ff" locale="en" onChange={change} />,
    );
    expect(screen.getByRole("textbox", { name: "HEX color" })).toHaveValue(
      "#0000FF",
    );
    expect(screen.getByRole("slider", { name: "Hue" })).toHaveValue("240");
    rerender(
      <AccentColorPicker value="#ffffff" locale="en" onChange={change} />,
    );
    expect(screen.getByRole("slider", { name: "Hue" })).toHaveValue("240");
    expect(change).not.toHaveBeenCalled();
  });
});
