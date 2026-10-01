import { Description, Label, Radio, RadioGroup } from "@headlessui/react";
import {
  ArrowUp,
  Check,
  Download,
  Monitor,
  Moon,
  Palette,
  RotateCcw,
  Sparkles,
  Sun,
  Upload,
} from "lucide-react";
import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { ACCENT_PRESETS, DEFAULT_ACCENT } from "../../../../lib/appearance";
import { DEFAULT_THEME } from "../../../../lib/theme/defaults";
import { BUILTIN_THEMES } from "../../../../lib/theme/presets";
import { themeToExport } from "../../../../lib/theme/normalize";
import {
  downloadThemeFile,
  getThemeImportErrorKind,
} from "../../../../lib/theme/io";
import {
  ensureThemeRuntime,
  exportActiveTheme,
  importThemeFile,
  useThemeStore,
  type ThemeMode,
} from "../../../state/themeStore";
import { useLocale } from "../../../../hooks/useLocale";
import { useNotificationStore } from "../../../state/notificationStore";
import { AccentColorPicker } from "./AccentColorPicker";
import { SettingsCard } from "./SettingsCard";
import type { GlobalConfig, MacWindowAppearance } from "../../../../lib/contracts/config";
import { applyMacWindowAppearance, desktopWindowApi, DEFAULT_MAC_WINDOW_APPEARANCE } from "../../../../lib/mac-window-appearance";
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
  const preset = ACCENT_PRESETS.find((item) => item.color === accent);
  const colorName = preset ? preset[locale] : zh ? "自定义" : "Custom";
  const themeSource =
    source === "imported" ? (zh ? "已导入" : "Imported") : zh ? "内置" : "Built-in";
  const resetDisabled =
    source === "builtin" && themesEquivalent(activeTheme, DEFAULT_THEME);
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

  return (
    <SettingsCard
      title={zh ? "外观" : "Appearance"}
      icon={Palette}
      description={
        zh ? "即时生效，自动保存" : "Applied instantly · saved automatically"
      }
    >
      <p
        className="appearance-visually-hidden"
        role={feedback?.type === "error" ? "alert" : "status"}
        aria-live={feedback?.type === "error" ? "assertive" : "polite"}
      >
        {feedback?.message}
      </p>
      <section
        className="appearance-theme-management"
        aria-labelledby="appearance-theme-management-title"
      >
        <h3
          id="appearance-theme-management-title"
          className="appearance-visually-hidden"
        >
          {zh ? "主题信息与操作" : "Theme information and actions"}
        </h3>
        <dl className="appearance-theme-meta">
          <div>
            <dt>{zh ? "主题名称" : "Theme name"}</dt>
            <dd>{activeTheme.name}</dd>
          </div>
          <div>
            <dt>{zh ? "来源" : "Source"}</dt>
            <dd>{themeSource}</dd>
          </div>
        </dl>
        <div className="appearance-theme-actions">
          <button
            type="button"
            className="appearance-action"
            onClick={() => importInputRef.current?.click()}
          >
            <Upload size={14} aria-hidden="true" />
            <span>{zh ? "导入主题" : "Import theme"}</span>
          </button>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            aria-label={zh ? "导入主题 JSON 文件" : "Import theme JSON file"}
            className="appearance-visually-hidden"
            onChange={handleImport}
          />
          <button type="button" className="appearance-action" onClick={handleExport}>
            <Download size={14} aria-hidden="true" />
            <span>{zh ? "导出主题" : "Export theme"}</span>
          </button>
          <button
            type="button"
            className="appearance-action"
            disabled={resetDisabled}
            onClick={handleReset}
          >
            <RotateCcw size={14} aria-hidden="true" />
            <span>{zh ? "恢复默认" : "Reset theme"}</span>
          </button>
        </div>
      </section>
      <section className="appearance-builtins" aria-labelledby="appearance-builtins-title">
        <div className="appearance-heading">
          <span id="appearance-builtins-title" className="appearance-label">
            {zh ? "经典主题" : "Classic themes"}
          </span>
          <span className="appearance-hint">
            {zh ? "选择一套熟悉的编辑器配色" : "Choose a familiar editor palette"}
          </span>
        </div>
        <div className="appearance-builtins-grid">
          {BUILTIN_THEMES.map((theme) => {
            const checked = activeTheme.id === theme.id && source === "builtin";
            const colors = theme.colors[resolved];
            return (
              <button
                type="button"
                key={theme.id}
                className="appearance-builtin"
                data-checked={checked ? "" : undefined}
                aria-pressed={checked}
                onClick={() => {
                  setActiveTheme(theme, "builtin");
                  ensureThemeRuntime();
                  announce("success", zh ? `已切换到「${theme.name}」` : `Switched to ${theme.name}`);
                }}
              >
                <span
                  className="appearance-builtin__preview"
                  style={{
                    background: colors.canvas,
                    borderColor: colors.border,
                  }}
                  aria-hidden="true"
                >
                  <i style={{ background: colors.accent }} />
                  <i style={{ background: colors.textMuted }} />
                  <i style={{ background: colors.borderStrong }} />
                </span>
                <span className="appearance-builtin__meta">
                  <strong>{theme.name}</strong>
                  <span>{theme.id === "synax-default" ? (zh ? "Synax" : "Default") : "Built-in"}</span>
                </span>
                <Check className="appearance-builtin__check" size={14} aria-hidden="true" />
              </button>
            );
          })}
        </div>
      </section>
      <RadioGroup value={mode} onChange={handleModeChange} className="appearance-modes">
        <div className="appearance-heading">
          <Label className="appearance-label">
            {zh ? "明暗模式" : "Color mode"}
          </Label>
          <Description as="span" className="appearance-hint" aria-live="polite">
            {mode === "system"
              ? zh
                ? `当前随系统使用${resolved === "dark" ? "深色" : "浅色"}`
                : `System is currently ${resolved}`
              : zh
                ? "选择适合你的工作氛围"
                : "Set the tone for your workspace"}
          </Description>
        </div>
        <div className="appearance-mode-group">
          {modes.map(({ id, label, Icon }) => (
            <Radio
              as="button"
              type="button"
              key={id}
              value={id}
              className="appearance-mode"
            >
              <span
                className={`appearance-mini appearance-mini--${id}`}
                aria-hidden="true"
              >
                <span className="appearance-mini__sidebar">
                  <i />
                  <i />
                  <i />
                </span>
                <span className="appearance-mini__content">
                  <i />
                  <i />
                  <span>
                    <i />
                    <b />
                  </span>
                </span>
              </span>
              <span className="appearance-mode__caption">
                <Icon size={14} aria-hidden="true" />
                <span>{label}</span>
                <span className="appearance-mode__check" aria-hidden="true">
                  <Check size={11} />
                </span>
              </span>
            </Radio>
          ))}
        </div>
      </RadioGroup>
      <div className="appearance-colors">
        <div className="appearance-palette">
          <div className="appearance-heading">
            <span className="appearance-label">
              {zh ? "主题色" : "Accent color"}
            </span>
            <span className="appearance-color-name" aria-live="polite">
              {colorName}
            </span>
          </div>
          <p className="appearance-hint">
            {zh
              ? "一点色彩，让专注更有自己的样子。"
              : "A little color. A workspace that feels like you."}
          </p>
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
                  <>{checked && <Check size={15} aria-hidden="true" />}</>
                )}
              </Radio>
            ))}
          </RadioGroup>
          <div className="appearance-custom-row">
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
              <RotateCcw size={14} aria-hidden="true" />
            </button>
          </div>
        </div>
        <div className="appearance-preview" aria-hidden="true">
          <div className="appearance-preview__header">
            <span>
              <Sparkles size={13} /> Synax
            </span>
            <span>{zh ? "实时预览" : "Live preview"}</span>
          </div>
          <div className="appearance-preview__body">
            <span className="appearance-preview__badge">
              <span />
              {zh ? "专注于下一步" : "Focus on what’s next"}
            </span>
            <div className="appearance-preview__line" />
            <div className="appearance-preview__line appearance-preview__line--short" />
            <div className="appearance-preview__composer">
              <span>{zh ? "从一个想法开始…" : "Start with an idea…"}</span>
              <span>
                <ArrowUp size={15} />
              </span>
            </div>
          </div>
        </div>
      </div>
      {isMac ? (
        <section className="appearance-window-material" aria-labelledby="appearance-window-material-title">
          <div className="appearance-heading">
            <span id="appearance-window-material-title" className="appearance-label">
              {zh ? "窗口材质" : "Window material"}
            </span>
            <span className="appearance-hint">
              {zh ? "即时生效，默认关闭；浓度越低，原生毛玻璃越明显" : "Applied instantly and disabled by default; lower density reveals more native frost"}
            </span>
          </div>
          <label className="appearance-window-row">
            <span>{zh ? "启用透明窗口" : "Enable transparent window"}</span>
            <input type="checkbox" checked={macAppearance.enabled} onChange={(event) => void updateMacAppearance({ enabled: event.target.checked })} />
          </label>
          <label className="appearance-window-row">
            <span>{zh ? "原生材质" : "Native material"}</span>
            <select value={macAppearance.vibrancy} onChange={(event) => void updateMacAppearance({ vibrancy: event.target.value as MacWindowAppearance["vibrancy"] })}>
              <option value="under-window">Under window</option>
              <option value="hud-window">HUD window</option>
              <option value="none">None</option>
            </select>
          </label>
          <label className="appearance-window-row">
            <span>{zh ? `毛玻璃浓度 ${Math.round(macAppearance.opacity * 100)}%` : `Glass density ${Math.round(macAppearance.opacity * 100)}%`}</span>
            <input type="range" min="0.35" max="1" step="0.01" value={macAppearance.opacity} onChange={(event) => void updateMacAppearance({ opacity: Number(event.target.value) })} />
          </label>
          <label className="appearance-window-row">
            <span>{zh ? "底部分隔线" : "Bottom separator"}</span>
            <input type="checkbox" checked={macAppearance.bottomSeparator} onChange={(event) => void updateMacAppearance({ bottomSeparator: event.target.checked })} />
          </label>
          <label className="appearance-window-row">
            <span>{zh ? "横向纹理" : "Scanlines"}</span>
            <input type="checkbox" checked={macAppearance.scanlines} onChange={(event) => void updateMacAppearance({ scanlines: event.target.checked })} />
          </label>
          {macAppearance.scanlines ? (
            <label className="appearance-window-row">
              <span>{zh ? `纹理强度 ${Math.round(macAppearance.scanlineOpacity * 1000) / 10}%` : `Scanline strength ${Math.round(macAppearance.scanlineOpacity * 1000) / 10}%`}</span>
              <input type="range" min="0" max="0.08" step="0.005" value={macAppearance.scanlineOpacity} onChange={(event) => void updateMacAppearance({ scanlineOpacity: Number(event.target.value) })} />
            </label>
          ) : null}
        </section>
      ) : null}
    </SettingsCard>
  );
}
