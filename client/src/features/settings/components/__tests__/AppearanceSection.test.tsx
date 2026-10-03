import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AppearanceSection } from "../AppearanceSection";
import { useShellStore } from "../../../../shared/state/shellStore";
import {
  hydrateThemePreferences,
  THEME_STORAGE_KEY,
  useThemeStore,
} from "../../../../shared/state/themeStore";
import { DEFAULT_ACCENT } from "../../../../shared/lib/appearance";
import { DEFAULT_THEME } from "../../../../shared/lib/theme/defaults";
import { useNotificationStore } from "../../../../shared/state/notificationStore";

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
  delete (window as Window & { electronAPI?: unknown }).electronAPI;
  for (const key of ["macWindowEnabled", "macWindowSeparator", "macWindowScanlines"]) delete document.documentElement.dataset[key];
  document.documentElement.style.removeProperty("--mac-window-opacity");
  document.documentElement.style.removeProperty("--mac-scanline-opacity");
  expect(fetchGuard).not.toHaveBeenCalled();
  resetThemeStore();
  useNotificationStore.setState({ notifications: [], unreadCount: 0 });
  localStorage.clear();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("AppearanceSection", () => {
  it("restores native and DOM appearance when saving fails", async () => {
    const native = vi.fn().mockResolvedValue(undefined);
    const onUpdate = vi.fn().mockRejectedValue(new Error("save failed"));
    Object.defineProperty(window, "electronAPI", { configurable: true, value: { platform: "darwin", setMacWindowAppearance: native } });
    render(<AppearanceSection onUpdate={onUpdate} />);
    await userEvent.setup().click(screen.getByRole("checkbox", { name: "Enable transparent window" }));
    expect(await screen.findByRole("alert")).toHaveTextContent("save failed");
    expect(native).toHaveBeenLastCalledWith(expect.objectContaining({ enabled: false }));
    expect(document.documentElement.dataset.macWindowEnabled).toBe("false");
    expect(document.documentElement.dataset.macWindowScanlines).toBe("false");
  });

  it("serializes rapid edits without resetting a newer preview to an older response", async () => {
    let resolveFirst!: () => void;
    const first = new Promise<void>((resolve) => { resolveFirst = resolve; });
    const onUpdate = vi.fn().mockImplementationOnce(() => first).mockResolvedValue(undefined);
    Object.defineProperty(window, "electronAPI", { configurable: true, value: { platform: "darwin", setMacWindowAppearance: vi.fn().mockResolvedValue(undefined) } });
    const { rerender } = render(<AppearanceSection onUpdate={onUpdate} />);
    const user = userEvent.setup();
    await user.click(screen.getByRole("checkbox", { name: "Enable transparent window" }));
    const density = screen.getByRole("slider", { name: /Glass density/ });
    fireEvent.change(density, { target: { value: "0.55" } });
    fireEvent.change(density, { target: { value: "0.35" } });
    expect(onUpdate).toHaveBeenCalledTimes(1);
    const old = onUpdate.mock.calls[0][0].macWindowAppearance;
    rerender(<AppearanceSection config={{ macWindowAppearance: old } as any} onUpdate={onUpdate} />);
    expect(document.documentElement.style.getPropertyValue("--mac-window-opacity")).toBe("0.35");
    await act(async () => resolveFirst());
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(3));
    expect(onUpdate).toHaveBeenLastCalledWith({ macWindowAppearance: expect.objectContaining({ enabled: true, opacity: 0.35 }) });
  });

  it("preserves the active material after leaving the settings page", async () => {
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: { platform: "darwin", setMacWindowAppearance: vi.fn().mockResolvedValue(undefined) },
    });
    const { unmount } = render(<AppearanceSection onUpdate={vi.fn().mockResolvedValue(undefined)} />);
    await userEvent.setup().click(screen.getByRole("checkbox", { name: "Enable transparent window" }));
    expect(document.documentElement.dataset.macWindowEnabled).toBe("true");
    unmount();
    expect(document.documentElement.dataset.macWindowEnabled).toBe("true");
    expect(document.documentElement.style.getPropertyValue("--mac-window-opacity")).toBe("0.82");
  });

  it("defaults the macOS window material to off and updates the glass controls", async () => {
    const user = userEvent.setup();
    const setMacWindowAppearance = vi.fn().mockResolvedValue(undefined);
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: { platform: "darwin", setMacWindowAppearance },
    });
    render(
      <AppearanceSection
        config={{
          macWindowAppearance: {
            enabled: false,
            vibrancy: "under-window",
            opacity: 0.82,
            bottomSeparator: true,
            scanlines: false,
            scanlineOpacity: 0.025,
          },
        } as any}
        onUpdate={onUpdate}
      />,
    );

    const enabled = screen.getByRole("checkbox", {
      name: "Enable transparent window",
    });
    expect(enabled).not.toBeChecked();
    await user.click(enabled);
    expect(setMacWindowAppearance).toHaveBeenLastCalledWith(
      expect.objectContaining({ enabled: true }),
    );
    expect(onUpdate).toHaveBeenLastCalledWith({
      macWindowAppearance: expect.objectContaining({ enabled: true }),
    });

    const density = screen.getByRole("slider", { name: /Glass density/ });
    fireEvent.change(density, { target: { value: "0.35" } });
    expect(setMacWindowAppearance).toHaveBeenLastCalledWith(
      expect.objectContaining({ opacity: 0.35 }),
    );
  });

  it("rolls back the macOS material control when persistence fails", async () => {
    const user = userEvent.setup();
    const setMacWindowAppearance = vi
      .fn()
      .mockRejectedValue(new Error("configuration rejected"));
    Object.defineProperty(window, "electronAPI", {
      configurable: true,
      value: { platform: "darwin", setMacWindowAppearance },
    });
    render(
      <AppearanceSection
        config={{
          macWindowAppearance: {
            enabled: false,
            vibrancy: "under-window",
            opacity: 0.82,
            bottomSeparator: true,
            scanlines: false,
            scanlineOpacity: 0.025,
          },
        } as any}
      />,
    );

    const enabled = screen.getByRole("checkbox", {
      name: "Enable transparent window",
    });
    await user.click(enabled);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "configuration rejected",
    );
    expect(enabled).not.toBeChecked();
  });

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
    const resetTheme = screen.getByRole("button", { name: "Reset theme" });
    expect(reset).toBeDisabled();
    expect(resetTheme).toBeDisabled();
    // The old option role was invalid inside a radiogroup; test actual radio semantics.
    const swatch = screen.getByRole("radio", { name: "Iris" });
    fireEvent.click(swatch);
    expect(swatch).toBeChecked();
    expect(resetTheme).toBeEnabled();
    expect(useThemeStore.getState().activeTheme.colors.light.accent).toBe(
      "#b1a2c9",
    );
    expect(screen.getByText("#B1A2C9")).toBeInTheDocument();
    fireEvent.click(reset);
    fireEvent.click(resetTheme);
    expect(useThemeStore.getState()).toMatchObject({
      mode: "system",
      activeTheme: { colors: { light: { accent: DEFAULT_ACCENT } } },
    });
    expect(reset).toBeDisabled();
    expect(resetTheme).toBeDisabled();
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

  it("uses the resolved mode accent without flattening imported light and dark accents", async () => {
    const user = userEvent.setup();
    render(<AppearanceSection />);
    await user.click(screen.getByRole("radio", { name: "Dark" }));
    await user.upload(
      screen.getByLabelText("Import theme JSON file"),
      new File(
        [
          JSON.stringify({
            version: 1,
            id: "mist-blue",
            name: "Mist Blue",
            colors: {
              light: { accent: "#98aecb" },
              dark: { accent: "#b1a2c9" },
            },
          }),
        ],
        "mist.json",
        { type: "application/json" },
      ),
    );

    expect(useThemeStore.getState().activeTheme.colors).toMatchObject({
      light: { accent: "#98aecb" },
      dark: { accent: "#b1a2c9" },
    });
    expect(screen.getByText("#B1A2C9")).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: "Light" }));
    expect(screen.getByText("#98AECB")).toBeInTheDocument();
  });

  it("reports localized errors for unreadable, malformed, invalid, and unsupported theme files", async () => {
    const user = userEvent.setup();
    render(<AppearanceSection />);
    const input = screen.getByLabelText("Import theme JSON file");

    const unreadable = new File(["{}"], "unreadable.json", { type: "application/json" });
    Object.defineProperty(unreadable, "text", {
      configurable: true,
      value: vi.fn().mockRejectedValue(new Error("read failed")),
    });
    await user.upload(input, unreadable);
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Could not read the theme file. Please try again.",
    );

    await user.upload(
      input,
      new File(["{bad"], "malformed.json", { type: "application/json" }),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The theme file contains invalid JSON.",
    );

    await user.upload(
      input,
      new File(
        [
          JSON.stringify({
            version: 1,
            id: "invalid",
            name: "Invalid",
            colors: { light: { accent: "var(--unsafe)" } },
          }),
        ],
        "invalid.json",
        { type: "application/json" },
      ),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "The theme file has an invalid Synax theme format.",
    );

    await user.upload(
      input,
      new File(
        [JSON.stringify({ version: 2, id: "future", name: "Future" })],
        "future.json",
        { type: "application/json" },
      ),
    );
    expect(screen.getByRole("alert")).toHaveTextContent(
      "This theme version is not supported. Choose a compatible Synax theme file.",
    );
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
      "The theme file contains invalid JSON.",
    );
    expect(useThemeStore.getState().activeTheme).toBe(before.activeTheme);
    expect(useThemeStore.getState().source).toBe(before.source);
    expect(useNotificationStore.getState().notifications[0]).toMatchObject({
      type: "error",
      message: "The theme file contains invalid JSON.",
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
    expect(screen.getAllByText("Synax Default").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Built-in").length).toBeGreaterThan(0);
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
      "主题文件包含无效的 JSON。",
    );
    expect(useNotificationStore.getState().notifications[0]).toMatchObject({
      type: "error",
      message: "主题文件包含无效的 JSON。",
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
