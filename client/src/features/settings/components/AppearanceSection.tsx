import { InfoTooltip } from "@/shared/ui/ui/InfoTooltip";
import { Radio, RadioGroup } from "@headlessui/react";
import {
  Check,
  Download,
  Monitor,
  Moon,
  Palette,
  RotateCcw,
  Sun,
  Upload,
} from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { ACCENT_PRESETS, DEFAULT_ACCENT } from "../../../shared/lib/appearance";
import { DEFAULT_THEME } from "../../../shared/lib/theme/defaults";
import { BUILTIN_THEMES, DEFAULT_APP_THEME } from "../../../shared/lib/theme/presets";
import { themeToExport } from "../../../shared/lib/theme/normalize";
import {
  downloadThemeFile,
  getThemeImportErrorKind,
} from "../../../shared/lib/theme/io";
import {
  ensureThemeRuntime,
  exportActiveTheme,
  importThemeFile,
  useThemeStore,
  type ThemeMode,
} from "../../../shared/state/themeStore";
import { useLocale } from "../../../shared/hooks/useLocale";
import { useNotificationStore } from "../../../shared/state/notificationStore";
import { AccentColorPicker } from "./AccentColorPicker";
import { FormRow } from "./FormRow";
import { SettingsCard } from "./SettingsCard";
import type { GlobalConfig, MacWindowAppearance } from "../../../shared/contracts/config";
import { applyMacWindowAppearance, desktopWindowApi, DEFAULT_MAC_WINDOW_APPEARANCE } from "../../../adapters/electron/mac-window-appearance";
import "./appearance.css";

type AppearanceFeedback = {
  type: "success" | "error";
  message: string;
};

function themesEquivalent(first: typeof DEFAULT_THEME, second: typeof DEFAULT_THEME): boolean {
  return JSON.stringify(themeToExport(first)) === JSON.stringify(themeToExport(second));
}

function importErrorMessage(error: Error, zh: boolean): string {
  switch (getThemeImportErrorKind(error)) {
    case "file-read":
      return zh ? "无法读取主题文件，请重试。" : "Could not read the theme file. Please try again.";
    case "json-syntax":
      return zh ? "主题文件包含无效的 JSON。" : "The theme file contains invalid JSON.";
    case "schema-invalid":
      return zh
        ? "主题文件格式无效，请选择有效的 Synax 主题文件。"
        : "The theme file has an invalid Synax theme format.";
    case "unsupported-version":
      return zh
        ? "不支持的主题版本，请使用兼容的 Synax 主题文件。"
        : "This theme version is not supported. Choose a compatible Synax theme file.";
    case "file-too-large":
      return zh ? "主题文件过大。" : "The theme file is too large.";
    default:
      return zh
        ? "导入失败，请选择有效的 Synax 主题 JSON 文件。"
        : "Import failed. Choose a valid Synax theme JSON file.";
  }
}

type AppearanceSectionProps = {
  config?: GlobalConfig;
  onUpdate?: (patch: { macWindowAppearance: MacWindowAppearance }) => Promise<void>;
};

export function AppearanceSection({ config, onUpdate }: AppearanceSectionProps) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const mode = useThemeStore((s) => s.mode);
  const resolved = useThemeStore((s) => s.resolvedTheme);
  const activeTheme = useThemeStore((s) => s.activeTheme);
  const source = useThemeStore((s) => s.source);
  const accent = activeTheme.colors[resolved].accent;
  const setMode = useThemeStore((s) => s.setMode);
  const setAccent = useThemeStore((s) => s.setAccentColor);
  const resetTheme = useThemeStore((s) => s.resetTheme);
  const setActiveTheme = useThemeStore((s) => s.setActiveTheme);
  const [feedback, setFeedback] = useState<AppearanceFeedback | null>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const themeSource =
    source === "imported" ? (zh ? "已导入" : "Imported") : zh ? "内置" : "Built-in";
  const resetDisabled =
    source === "builtin" && themesEquivalent(activeTheme, DEFAULT_APP_THEME);
  const modes = [
    { id: "light", label: zh ? "浅色" : "Light", Icon: Sun },
    { id: "dark", label: zh ? "深色" : "Dark", Icon: Moon },
    { id: "system", label: zh ? "跟随系统" : "System", Icon: Monitor },
  ] as const;
  const isMac = desktopWindowApi()?.platform === "darwin";
  const [macAppearance, setMacAppearance] = useState<MacWindowAppearance>(
    config?.macWindowAppearance ?? DEFAULT_MAC_WINDOW_APPEARANCE,
  );

  const latestAppearance = useRef(macAppearance);
  const savedAppearance = useRef(macAppearance);
  const pending = useRef(0);
  const revision = useRef(0);
  const saveQueue = useRef(Promise.resolve());

  useEffect(() => {
    if (!isMac || pending.current > 0) return;
    const next = config?.macWindowAppearance ?? DEFAULT_MAC_WINDOW_APPEARANCE;
    latestAppearance.current = savedAppearance.current = next;
    setMacAppearance(next);
    void applyMacWindowAppearance(next).catch((error: unknown) => {
      announce("error", error instanceof Error ? error.message : "Could not update window appearance");
    });
  }, [config?.macWindowAppearance, isMac]);

  const updateMacAppearance = (patch: Partial<MacWindowAppearance>) => {
    const next = { ...latestAppearance.current, ...patch };
    latestAppearance.current = next;
    const currentRevision = ++revision.current;
    pending.current++;
    setMacAppearance(next);
    // Preview immediately; serialize persistence so a slower slider response
    // cannot overwrite a newer edit. Handle the preview rejection immediately.
    const preview = applyMacWindowAppearance(next).then(
      () => ({ ok: true as const }),
      (error: unknown) => ({ ok: false as const, error }),
    );
    saveQueue.current = saveQueue.current.then(async () => {
      try {
        const result = await preview;
        if (!result.ok) throw result.error;
        await onUpdate?.({ macWindowAppearance: next });
        savedAppearance.current = next;
      } catch (error) {
        if (currentRevision !== revision.current) return;
        const previous = savedAppearance.current;
        latestAppearance.current = previous;
        setMacAppearance(previous);
        // Restore both the native and DOM state, not just the checkbox.
        await applyMacWindowAppearance(previous).catch(() => undefined);
        announce("error", error instanceof Error ? error.message : zh ? "窗口效果更新失败" : "Could not update window appearance");
      } finally {
        pending.current--;
      }
    });
  };

  const announce = (type: AppearanceFeedback["type"], message: string) => {
    setFeedback({ type, message });
    useNotificationStore.getState().push({ type, message });
  };

  const handleModeChange = (nextMode: ThemeMode) => {
    setMode(nextMode);
    ensureThemeRuntime();
  };

  const handleAccentChange = (nextAccent: string) => {
    setAccent(nextAccent);
    ensureThemeRuntime();
  };

  const handleImport = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.currentTarget.files?.[0];
    event.currentTarget.value = "";
    if (!file) return;

    try {
      const result = await importThemeFile(file);
      if (!result.ok) {
        announce("error", importErrorMessage(result.error, zh));
        return;
      }
      ensureThemeRuntime();
      announce(
        "success",
        zh
          ? `已导入主题「${result.theme.name}」`
          : `Imported theme “${result.theme.name}”`,
      );
    } catch {
      announce(
        "error",
        zh
          ? "导入失败，请选择有效的 Synax 主题 JSON 文件。"
          : "Import failed. Choose a valid Synax theme JSON file.",
      );
    }
  };

  const handleExport = () => {
    try {
      downloadThemeFile(exportActiveTheme());
      announce("success", zh ? "主题已导出" : "Theme exported");
    } catch {
      announce("error", zh ? "主题导出失败" : "Theme export failed");
    }
  };

  const handleReset = () => {
    resetTheme();
    ensureThemeRuntime();
    announce(
      "success",
      zh ? "已恢复内置默认主题" : "Restored built-in default theme",
    );
  };
  const title = isMac
    ? zh
      ? "外观与窗口"
      : "Appearance & window"
    : zh
      ? "外观"
      : "Appearance";
  const densityPercent = Math.round(macAppearance.opacity * 100);
  const scanlinePercent = Math.round(macAppearance.scanlineOpacity * 1000) / 10;

  return (
    <SettingsCard
      title={title}
      icon={Palette}
      trailing={
        <div className="appearance-card-actions">
          <span className="appearance-theme-name" title={activeTheme.name}>
            {activeTheme.name}
          </span>
          <span className="appearance-theme-source">{themeSource}</span>
          <span className="appearance-action-group">
            <button
              type="button"
              className="appearance-icon-button"
              aria-label={zh ? "导入主题" : "Import theme"}
              title={zh ? "导入主题" : "Import theme"}
              onClick={() => importInputRef.current?.click()}
            >
              <Upload size={13} aria-hidden="true" />
            </button>
            <input
              ref={importInputRef}
              type="file"
              accept="application/json,.json"
              aria-label={zh ? "导入主题 JSON 文件" : "Import theme JSON file"}
              className="appearance-visually-hidden"
              onChange={handleImport}
            />
            <button
              type="button"
              className="appearance-icon-button"
              aria-label={zh ? "导出主题" : "Export theme"}
              title={zh ? "导出主题" : "Export theme"}
              onClick={handleExport}
            >
              <Download size={13} aria-hidden="true" />
            </button>
            <button
              type="button"
              className="appearance-icon-button"
              disabled={resetDisabled}
              aria-label={zh ? "恢复默认主题" : "Reset theme"}
              title={zh ? "恢复默认主题" : "Reset theme"}
              onClick={handleReset}
            >
              <RotateCcw size={13} aria-hidden="true" />
            </button>
          </span>
        </div>
      }
    >
      <p
        className="appearance-visually-hidden"
        role={feedback?.type === "error" ? "alert" : "status"}
        aria-live={feedback?.type === "error" ? "assertive" : "polite"}
      >
        {feedback?.message}
      </p>
      <div className="settings-rows appearance-rows">
        <FormRow label={zh ? "色彩模式" : "Color mode"}>
          <div className="appearance-mode-cluster">
            <RadioGroup
              value={mode}
              onChange={handleModeChange}
              aria-label={zh ? "色彩模式" : "Color mode"}
              className="appearance-modes"
            >
              {modes.map(({ id, label, Icon }) => (
                <Radio
                  as="button"
                  type="button"
                  key={id}
                  value={id}
                  className="appearance-mode"
                >
                  <Icon size={13} aria-hidden="true" />
                  <span>{label}</span>
                  <Check
                    size={11}
                    aria-hidden="true"
                    className="appearance-mode__check"
                  />
                </Radio>
              ))}
            </RadioGroup>
            {mode === "system" && (
              <span className="appearance-hint" aria-live="polite">
                {zh
                  ? `系统：${resolved === "dark" ? "深色" : "浅色"}`
                  : `System: ${resolved}`}
              </span>
            )}
          </div>
        </FormRow>

        <FormRow label={zh ? "经典主题" : "Classic themes"}>
          <div className="appearance-theme-chips">
            {BUILTIN_THEMES.map((theme) => {
              const checked = activeTheme.id === theme.id && source === "builtin";
              const colors = theme.colors[resolved];
              return (
                <button
                  type="button"
                  key={theme.id}
                  className="appearance-chip"
                  data-checked={checked ? "" : undefined}
                  aria-pressed={checked}
                  title={theme.name}
                  onClick={() => {
                    setActiveTheme(theme, "builtin");
                    ensureThemeRuntime();
                    announce(
                      "success",
                      zh
                        ? `已切换到「${theme.name}」`
                        : `Switched to ${theme.name}`,
                    );
                  }}
                >
                  <span
                    className="appearance-chip__preview"
                    style={{
                      background: colors.canvas,
                      borderColor: colors.border,
                    }}
                    aria-hidden="true"
                  >
                    <i style={{ background: colors.accent }} />
                    <i style={{ background: colors.textMuted }} />
                  </span>
                  <span className="appearance-chip__name">{theme.name}</span>
                </button>
              );
            })}
          </div>
        </FormRow>

        <FormRow label={zh ? "主题色" : "Accent color"}>
          <div className="appearance-accent-row">
            <RadioGroup
              value={accent}
              onChange={handleAccentChange}
              aria-label={zh ? "预设主题色" : "Accent presets"}
              className="appearance-swatches"
            >
              {ACCENT_PRESETS.map((item) => (
                <Radio
                  as="button"
                  type="button"
                  key={item.color}
                  value={item.color}
                  aria-label={item[locale]}
                  className="appearance-swatch"
                  style={{ backgroundColor: item.color }}
                >
                  {({ checked }) => (
                    <>{checked && <Check size={13} aria-hidden="true" />}</>
                  )}
                </Radio>
              ))}
            </RadioGroup>
            <AccentColorPicker
              value={accent}
              onChange={handleAccentChange}
              locale={locale}
            />
            <button
              type="button"
              className="appearance-icon-button"
              disabled={accent === DEFAULT_ACCENT}
              aria-label={zh ? "恢复默认主题色" : "Reset accent color"}
              title={zh ? "恢复默认主题色" : "Reset accent color"}
              onClick={() => handleAccentChange(DEFAULT_ACCENT)}
            >
              <RotateCcw size={13} aria-hidden="true" />
            </button>
          </div>
        </FormRow>
      </div>
      {isMac ? (
        <section
          className="appearance-window-material"
          aria-labelledby="appearance-window-material-title"
        >
          <div className="appearance-group-head">
            <span
              id="appearance-window-material-title"
              className="appearance-group-title"
            >
              {zh ? "窗口材质" : "Window material"}
            </span>
            <InfoTooltip label={zh ? "窗口材质说明" : "About window material"}>
              {zh
                ? "浓度越低，窗口越透明。"
                : "Lower density makes the window more transparent."}
            </InfoTooltip>
          </div>
          <div className="settings-rows settings-rows--split">
            <FormRow label={zh ? "透明窗口" : "Transparent window"}>
              <input
                type="checkbox"
                className="appearance-check"
                checked={macAppearance.enabled}
                aria-label={zh ? "启用透明窗口" : "Enable transparent window"}
                onChange={(event) =>
                  void updateMacAppearance({ enabled: event.target.checked })
                }
              />
            </FormRow>
            <FormRow
              label={
                zh
                  ? `毛玻璃浓度 ${densityPercent}%`
                  : `Glass density ${densityPercent}%`
              }
            >
              <input
                type="range"
                className="appearance-range"
                min="0.35"
                max="1"
                step="0.01"
                value={macAppearance.opacity}
                aria-label={
                  zh
                    ? `毛玻璃浓度 ${densityPercent}%`
                    : `Glass density ${densityPercent}%`
                }
                onChange={(event) =>
                  void updateMacAppearance({ opacity: Number(event.target.value) })
                }
              />
            </FormRow>
            <FormRow label={zh ? "原生材质" : "Native material"}>
              <select
                className="appearance-select"
                value={macAppearance.vibrancy}
                aria-label={zh ? "原生材质" : "Native material"}
                onChange={(event) =>
                  void updateMacAppearance({
                    vibrancy: event.target.value as MacWindowAppearance["vibrancy"],
                  })
                }
              >
                <option value="under-window">Under window</option>
                <option value="hud-window">HUD window</option>
                <option value="none">None</option>
              </select>
            </FormRow>
            <FormRow label={zh ? "底部分隔线" : "Bottom separator"}>
              <input
                type="checkbox"
                className="appearance-check"
                checked={macAppearance.bottomSeparator}
                aria-label={zh ? "底部分隔线" : "Bottom separator"}
                onChange={(event) =>
                  void updateMacAppearance({
                    bottomSeparator: event.target.checked,
                  })
                }
              />
            </FormRow>
            <FormRow label={zh ? "横向纹理" : "Scanlines"}>
              <input
                type="checkbox"
                className="appearance-check"
                checked={macAppearance.scanlines}
                aria-label={zh ? "横向纹理" : "Scanlines"}
                onChange={(event) =>
                  void updateMacAppearance({ scanlines: event.target.checked })
                }
              />
            </FormRow>
            {macAppearance.scanlines ? (
              <FormRow
                label={
                  zh
                    ? `纹理强度 ${scanlinePercent}%`
                    : `Scanline strength ${scanlinePercent}%`
                }
              >
                <input
                  type="range"
                  className="appearance-range"
                  min="0"
                  max="0.08"
                  step="0.005"
                  value={macAppearance.scanlineOpacity}
                  aria-label={
                    zh
                      ? `纹理强度 ${scanlinePercent}%`
                      : `Scanline strength ${scanlinePercent}%`
                  }
                  onChange={(event) =>
                    void updateMacAppearance({
                      scanlineOpacity: Number(event.target.value),
                    })
                  }
                />
              </FormRow>
            ) : null}
          </div>
        </section>
      ) : null}
    </SettingsCard>
  );
}
