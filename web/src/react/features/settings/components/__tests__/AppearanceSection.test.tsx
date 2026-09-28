import { act, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppearanceSection } from "../AppearanceSection";
import { useShellStore } from "../../../../state/shellStore";
import {
  hydrateThemePreferences,
  THEME_STORAGE_KEY,
  useThemeStore,
} from "../../../../state/themeStore";
import { DEFAULT_ACCENT } from "../../../../../lib/appearance";
import { DEFAULT_THEME } from "../../../../../lib/theme/defaults";
import { useNotificationStore } from "../../../../state/notificationStore";

const storageKey = THEME_STORAGE_KEY;
const fetchGuard = vi.fn(() =>
  Promise.reject(new Error("Appearance tests must not use an API")),
);

function resetThemeStore(): void {
  useThemeStore.setState((state) => ({
    ...state,
    mode: "system",
    activeTheme: DEFAULT_THEME,
    source: "builtin",
    resolvedTheme: "light",
    resolvedTokens: {
      colors: { ...DEFAULT_THEME.colors.light },
      shape: { ...DEFAULT_THEME.shape },
      effects: { ...DEFAULT_THEME.effects.light },
    },
  }));
}

beforeEach(() => {
  fetchGuard.mockClear();
  vi.stubGlobal("fetch", fetchGuard);
  localStorage.clear();
  resetThemeStore();
  useNotificationStore.setState({ notifications: [], unreadCount: 0 });
  hydrateThemePreferences();
  useShellStore.setState((state) => ({
    preferences: { ...state.preferences, locale: "en" },
  }));
});

afterEach(() => {
  expect(fetchGuard).not.toHaveBeenCalled();
  resetThemeStore();
  useNotificationStore.setState({ notifications: [], unreadCount: 0 });
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AppearanceSection", () => {
  it("uses accessible exclusive mode choices and keeps system status current", () => {
    render(<AppearanceSection />);
    expect(screen.getByRole("radio", { name: "System" })).toBeChecked();
    fireEvent.click(screen.getByRole("radio", { name: "Dark" }));
    expect(useThemeStore.getState().mode).toBe("dark");
    fireEvent.click(screen.getByRole("radio", { name: "System" }));
    vi.spyOn(window, "matchMedia").mockReturnValue({
      matches: true,
      media: "(prefers-color-scheme: dark)",
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      addListener: vi.fn(),
      removeListener: vi.fn(),
      dispatchEvent: vi.fn(),
    } as unknown as MediaQueryList);
    act(() => useThemeStore.getState().setMode("system"));
    expect(useThemeStore.getState().mode).toBe("system");
    expect(useThemeStore.getState().resolvedTheme).toBe("dark");
    expect(screen.getByText("System is currently dark")).toBeInTheDocument();
  });

  it("selects a preset and restores the Synax accent without changing mode", () => {
    render(<AppearanceSection />);
    const reset = screen.getByRole("button", { name: "Reset accent color" });
    expect(reset).toBeDisabled();
    // The old option role was invalid inside a radiogroup; test actual radio semantics.
    const swatch = screen.getByRole("radio", { name: "Iris" });
    fireEvent.click(swatch);
    expect(swatch).toBeChecked();
    expect(useThemeStore.getState().activeTheme.colors.light.accent).toBe(
      "#b1a2c9",
    );
    expect(screen.getByText("#B1A2C9")).toBeInTheDocument();
    fireEvent.click(reset);
    expect(useThemeStore.getState()).toMatchObject({
      mode: "system",
      activeTheme: { colors: { light: { accent: DEFAULT_ACCENT } } },
    });
    expect(reset).toBeDisabled();
  });

  it("supports radio arrow navigation with one tab stop, correct roles and all three persisted modes", async () => {
    const user = userEvent.setup();
    render(<AppearanceSection />);
    const modes = within(
      screen.getByRole("radiogroup", { name: "Color mode" }),
    );
    expect(modes.getAllByRole("radio")).toHaveLength(3);
    modes.getByRole("radio", { name: "System" }).focus();
    await user.keyboard("{ArrowLeft}");
    expect(modes.getByRole("radio", { name: "Dark" })).toHaveFocus();
    expect(useThemeStore.getState().mode).toBe("dark");
    await user.keyboard("{ArrowLeft}");
    expect(modes.getByRole("radio", { name: "Light" })).toBeChecked();
    expect(useThemeStore.getState().mode).toBe("light");
    await user.keyboard("{ArrowLeft}");
    expect(modes.getByRole("radio", { name: "System" })).toBeChecked();
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toMatchObject({
      mode: "system",
    });
    expect(
      modes.getAllByRole("radio").filter((radio) => radio.tabIndex === 0),
    ).toHaveLength(1);
    const presets = within(
      screen.getByRole("radiogroup", { name: "Accent presets" }),
    );
    expect(presets.queryAllByRole("option")).toHaveLength(0);
    expect(presets.getAllByRole("radio")).toHaveLength(7);
    presets.getByRole("radio", { name: "Sage" }).focus();
    await user.keyboard("{ArrowRight}");
    expect(presets.getByRole("radio", { name: "Celadon" })).toBeChecked();
    expect(useThemeStore.getState().activeTheme.colors.light.accent).toBe(
      "#94b8b5",
    );
    expect(
      presets.getAllByRole("radio").filter((radio) => radio.tabIndex === 0),
    ).toHaveLength(1);
  });

  it("persists valid custom changes immediately, updates the live theme, and hydrates them without changing mode", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<AppearanceSection />);
    await user.click(screen.getByRole("radio", { name: "Dark" }));
    await user.click(
      screen.getByRole("button", { name: "Custom accent color" }),
    );
    const hex = screen.getByRole("textbox", { name: "HEX color" });
    fireEvent.change(hex, { target: { value: "#ff0000" } });
    fireEvent.change(screen.getByRole("slider", { name: "Hue" }), {
      target: { value: "240" },
    });
    expect(hex).toHaveValue("#0000FF");
    expect(useThemeStore.getState()).toMatchObject({
      mode: "dark",
      activeTheme: { colors: { light: { accent: "#0000ff" } } },
    });
    expect(
      document.documentElement.style.getPropertyValue("--cx-accent-bottom"),
    ).toBe("#0000ff");
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toMatchObject({
      mode: "dark",
      theme: { colors: { light: { accent: "#0000ff" } } },
    });
    fireEvent.change(hex, { target: { value: "#12" } });
    expect(JSON.parse(localStorage.getItem(storageKey)!)).toMatchObject({
      theme: { colors: { light: { accent: "#0000ff" } } },
    });
    unmount();
    act(() => {
      resetThemeStore();
      hydrateThemePreferences();
    });
    render(<AppearanceSection />);
    expect(screen.getByRole("radio", { name: "Dark" })).toBeChecked();
    expect(screen.getByText("#0000FF")).toBeInTheDocument();
    expect(
      within(screen.getByRole("radiogroup", { name: "Accent presets" }))
        .getAllByRole("radio")
        .every((radio) => radio.getAttribute("aria-checked") === "false"),
    ).toBe(true);
  });

  it("imports valid JSON with accessible metadata and localized success feedback", async () => {
    const user = userEvent.setup();
    render(<AppearanceSection />);

    const file = new File(
      [
        JSON.stringify({
          version: 1,
          id: "mist-blue",
          name: "Mist Blue",
          colors: { light: { accent: "#98aecb" } },
        }),
      ],
      "mist.json",
      { type: "application/json" },
    );
    await user.upload(screen.getByLabelText("Import theme JSON file"), file);

    expect(useThemeStore.getState()).toMatchObject({
      source: "imported",
      activeTheme: {
        id: "mist-blue",
        name: "Mist Blue",
        colors: { light: { accent: "#98aecb" } },
      },
    });
    expect(screen.getByText("Mist Blue")).toBeInTheDocument();
    expect(screen.getByText("Imported")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("Imported theme “Mist Blue”");
    expect(useNotificationStore.getState().notifications[0]).toMatchObject({
      type: "success",
      message: "Imported theme “Mist Blue”",
    });
  });

  it("rejects invalid imports with an alert and leaves the active theme unchanged", async () => {
    const user = userEvent.setup();
    render(<AppearanceSection />);
    const before = useThemeStore.getState();

    await user.upload(
      screen.getByLabelText("Import theme JSON file"),
      new File(["{bad"], "broken.json", { type: "application/json" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Import failed. Choose a valid Synax theme JSON file.",
    );
    expect(useThemeStore.getState().activeTheme).toBe(before.activeTheme);
    expect(useThemeStore.getState().source).toBe(before.source);
    expect(useNotificationStore.getState().notifications[0]).toMatchObject({
      type: "error",
      message: "Import failed. Choose a valid Synax theme JSON file.",
    });
  });

  it("exports the normalized active theme and reports success", async () => {
    const user = userEvent.setup();
    const createObjectURL = vi.fn(() => "blob:theme");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL });
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    render(<AppearanceSection />);

    await user.click(screen.getByRole("button", { name: "Export theme" }));

    expect(createObjectURL).toHaveBeenCalledTimes(1);
    const blob = createObjectURL.mock.calls[0][0] as Blob;
    expect(JSON.parse(await blob.text())).toMatchObject({
      version: 1,
      id: "synax-default",
      name: "Synax Default",
      colors: { light: { accent: DEFAULT_ACCENT } },
    });
    expect(screen.getByRole("status")).toHaveTextContent("Theme exported");
    expect(useNotificationStore.getState().notifications[0]).toMatchObject({
      type: "success",
      message: "Theme exported",
    });
  });

  it("resets an imported theme to the built-in default without changing mode", async () => {
    const user = userEvent.setup();
    render(<AppearanceSection />);
    await user.click(screen.getByRole("radio", { name: "Dark" }));
    await user.upload(
      screen.getByLabelText("Import theme JSON file"),
      new File(
        [JSON.stringify({ version: 1, id: "mist-blue", name: "Mist Blue", colors: { light: { accent: "#98aecb" } } })],
        "mist.json",
        { type: "application/json" },
      ),
    );
    await user.click(screen.getByRole("button", { name: "Reset theme" }));

    expect(useThemeStore.getState()).toMatchObject({
      mode: "dark",
      source: "builtin",
      activeTheme: DEFAULT_THEME,
    });
    expect(screen.getByText("Synax Default")).toBeInTheDocument();
    expect(screen.getByText("Built-in")).toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent(
      "Restored built-in default theme",
    );
  });

  it("localizes theme metadata and import errors", async () => {
    const user = userEvent.setup();
    act(() =>
      useShellStore.setState((state) => ({
        preferences: { ...state.preferences, locale: "zh" },
      })),
    );
    render(<AppearanceSection />);

    expect(screen.getByText("主题名称")).toBeInTheDocument();
    expect(screen.getByText("来源")).toBeInTheDocument();
    await user.upload(
      screen.getByLabelText("导入主题 JSON 文件"),
      new File(["{bad"], "broken.json", { type: "application/json" }),
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "导入失败，请选择有效的 Synax 主题 JSON 文件。",
    );
    expect(useNotificationStore.getState().notifications[0]).toMatchObject({
      type: "error",
      message: "导入失败，请选择有效的 Synax 主题 JSON 文件。",
    });
  });

  it("localizes mode, preset, field, description and validation labels", async () => {
    const user = userEvent.setup();
    act(() =>
      useShellStore.setState((state) => ({
        preferences: { ...state.preferences, locale: "zh" },
      })),
    );
    render(<AppearanceSection />);
    expect(screen.getByRole("radio", { name: "跟随系统" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "鼠尾草" })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "自定义主题色" }));
    expect(
      screen.getByRole("group", { name: "饱和度与亮度" }),
    ).toBeInTheDocument();
    for (const name of ["色相", "饱和度", "亮度"]) {
      expect(screen.getByRole("slider", { name })).toHaveAccessibleDescription(
        /方向键/,
      );
    }
    const hex = screen.getByRole("textbox", { name: "HEX 色值" });
    await user.clear(hex);
    await user.type(hex, "#12{Enter}");
    expect(screen.getByRole("alert")).toHaveTextContent(/有效.*HEX/);
    await user.click(screen.getByRole("button", { name: "关闭调色盘" }));
    expect(screen.getByRole("button", { name: "自定义主题色" })).toHaveFocus();
  });
});
