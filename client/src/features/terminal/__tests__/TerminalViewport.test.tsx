import { describe, expect, it, vi } from "vitest";
import { DEFAULT_THEME } from "../../../shared/lib/theme/defaults";
import { resolveThemeTokens } from "../../../shared/lib/theme/runtime";
import {
  applyTerminalTheme,
  isTerminalCopyShortcut,
  isTerminalPasteShortcut,
  terminalAcceptsInput,
  terminalTheme,
} from "../TerminalViewport";

describe("terminalTheme", () => {
  it("maps normalized resolved semantic tokens to xterm colors", () => {
    const tokens = resolveThemeTokens(DEFAULT_THEME, "dark");
    expect(terminalTheme(tokens)).toEqual({
      background: tokens.colors.canvas,
      foreground: tokens.colors.text,
      cursor: tokens.colors.accent,
      selectionBackground: tokens.colors.selection,
      black: tokens.colors.surfaceSecondary,
      brightBlack: tokens.colors.textMuted,
    });
  });

  it("uses updated token values without relying on a legacy shell accent", () => {
    const tokens = resolveThemeTokens(
      {
        ...DEFAULT_THEME,
        colors: {
          ...DEFAULT_THEME.colors,
          dark: {
            ...DEFAULT_THEME.colors.dark,
            canvas: "#010203",
            text: "#040506",
            accent: "#070809",
            selection: "#0a0b0c",
            surfaceSecondary: "#0d0e0f",
            textMuted: "#101112",
          },
        },
      },
      "dark",
    );

    expect(terminalTheme(tokens)).toMatchObject({
      background: "#010203",
      foreground: "#040506",
      cursor: "#070809",
      selectionBackground: "#0a0b0c",
      black: "#0d0e0f",
      brightBlack: "#101112",
    });
  });
});

it("updates an open terminal theme in place without reconnecting or changing input state", () => {
  const before = resolveThemeTokens(DEFAULT_THEME, "light");
  const after = resolveThemeTokens(DEFAULT_THEME, "dark");
  const options = {
    theme: terminalTheme(before),
    disableStdin: false,
  };
  const terminal = { options };
  const connection = {
    close: vi.fn(),
    reconnect: vi.fn(),
    prepareInput: vi.fn(),
    write: vi.fn(),
  };

  applyTerminalTheme(terminal, after);

  expect(terminal.options).toBe(options);
  expect(terminal.options.theme).toEqual(terminalTheme(after));
  expect(terminal.options.disableStdin).toBe(false);
  expect(connection.close).not.toHaveBeenCalled();
  expect(connection.reconnect).not.toHaveBeenCalled();
  expect(connection.prepareInput).not.toHaveBeenCalled();
  expect(connection.write).not.toHaveBeenCalled();
});

describe("terminal clipboard shortcuts", () => {
  it("copies a selection with the platform shortcut without stealing Ctrl+C", () => {
    expect(
      isTerminalCopyShortcut(
        { key: "c", metaKey: true, ctrlKey: false, shiftKey: false },
        "MacIntel",
      ),
    ).toBe(true);
    expect(
      isTerminalCopyShortcut(
        { key: "c", metaKey: false, ctrlKey: true, shiftKey: true },
        "Win32",
      ),
    ).toBe(true);
    expect(
      isTerminalCopyShortcut(
        { key: "c", metaKey: false, ctrlKey: true, shiftKey: false },
        "Linux",
      ),
    ).toBe(false);
  });

  it("uses desktop paste shortcuts while preserving Unix Ctrl+V", () => {
    expect(
      isTerminalPasteShortcut(
        { key: "v", metaKey: true, ctrlKey: false, shiftKey: false },
        "MacIntel",
      ),
    ).toBe(true);
    expect(
      isTerminalPasteShortcut(
        { key: "v", metaKey: false, ctrlKey: true, shiftKey: false },
        "Win32",
      ),
    ).toBe(true);
    expect(
      isTerminalPasteShortcut(
        { key: "v", metaKey: false, ctrlKey: true, shiftKey: true },
        "Linux",
      ),
    ).toBe(true);
    expect(
      isTerminalPasteShortcut(
        { key: "v", metaKey: false, ctrlKey: true, shiftKey: false },
        "Linux",
      ),
    ).toBe(false);
    expect(
      isTerminalPasteShortcut(
        { key: "Insert", metaKey: false, ctrlKey: false, shiftKey: true },
        "Linux",
      ),
    ).toBe(true);
  });
});

describe("terminal input availability", () => {
  it("only accepts input while the PTY is running", () => {
    expect(terminalAcceptsInput("active")).toBe(true);
    expect(terminalAcceptsInput("stopping")).toBe(false);
    expect(terminalAcceptsInput("closed")).toBe(false);
    expect(terminalAcceptsInput("unconfirmed")).toBe(false);
  });
});
