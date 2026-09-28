import { Description, Label, Radio, RadioGroup } from "@headlessui/react";
import {
  ArrowUp,
  Check,
  Monitor,
  Moon,
  Palette,
  RotateCcw,
  Sparkles,
  Sun,
} from "lucide-react";
import { ACCENT_PRESETS, DEFAULT_ACCENT } from "../../../../lib/appearance";
import { useLocale } from "../../../../hooks/useLocale";
import { useShellStore } from "../../../state/shellStore";
import { AccentColorPicker } from "./AccentColorPicker";
import { SettingsCard } from "./SettingsCard";
import "./appearance.css";

export function AppearanceSection() {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const mode = useShellStore((s) => s.preferences.theme);
  const resolved = useShellStore((s) => s.resolvedTheme);
  const accent = useShellStore((s) => s.preferences.accentColor);
  const setTheme = useShellStore((s) => s.setTheme);
  const setAccent = useShellStore((s) => s.setAccentColor);
  const preset = ACCENT_PRESETS.find((item) => item.color === accent);
  const colorName = preset ? preset[locale] : zh ? "自定义" : "Custom";
  const modes = [
    { id: "light", label: zh ? "浅色" : "Light", Icon: Sun },
    { id: "dark", label: zh ? "深色" : "Dark", Icon: Moon },
    { id: "system", label: zh ? "跟随系统" : "System", Icon: Monitor },
  ] as const;

  return (
    <SettingsCard
      title={zh ? "外观" : "Appearance"}
      icon={Palette}
      description={
        zh ? "即时生效，自动保存" : "Applied instantly · saved automatically"
      }
    >
      <RadioGroup value={mode} onChange={setTheme} className="appearance-modes">
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
            onChange={setAccent}
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
              onChange={setAccent}
              locale={locale}
            />
            <button
              type="button"
              className="appearance-icon-button"
              disabled={accent === DEFAULT_ACCENT}
              aria-label={zh ? "恢复默认主题色" : "Reset accent color"}
              title={zh ? "恢复默认主题色" : "Reset accent color"}
              onClick={() => setAccent(DEFAULT_ACCENT)}
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
    </SettingsCard>
  );
}
