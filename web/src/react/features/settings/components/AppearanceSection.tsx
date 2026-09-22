import { useState } from "react";
import {
  Button,
  ColorArea,
  ColorField,
  InputGroup,
  ColorPicker,
  ColorSlider,
  ColorSwatch,
  ColorSwatchPicker,
  Label,
  Radio,
  RadioGroup,
  Tooltip,
  parseColor,
  type ColorValue,
} from "@heroui/react";
import {
  ArrowUp,
  Check,
  Monitor,
  Moon,
  Palette,
  RotateCcw,
  SlidersHorizontal,
  Sparkles,
  Sun,
} from "lucide-react";
import {
  ACCENT_PRESETS,
  DEFAULT_ACCENT,
  type ThemeMode,
} from "../../../../lib/appearance";
import { useLocale } from "../../../../hooks/useLocale";
import { useShellStore } from "../../../state/shellStore";
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
  // Keep the Color object while dragging: HEX alone loses hue at white/black.
  const [pickerColor, setPickerColor] = useState<ColorValue>(() =>
    parseColor(accent).toFormat("hsb"),
  );
  const value =
    pickerColor.toString("hex").toLowerCase() === accent
      ? pickerColor
      : parseColor(accent).toFormat("hsb");
  const changeColor = (color: ColorValue | null) => {
    if (!color) return;
    setPickerColor(color.toFormat("hsb"));
    setAccent(color.toString("hex"));
  };
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
      <div className="appearance-modes">
        <div className="appearance-heading">
          <span className="appearance-label">
            {zh ? "明暗模式" : "Color mode"}
          </span>
          <span className="appearance-hint" aria-live="polite">
            {mode === "system"
              ? zh
                ? `当前随系统使用${resolved === "dark" ? "深色" : "浅色"}`
                : `System is currently ${resolved}`
              : zh
                ? "选择适合你的工作氛围"
                : "Set the tone for your workspace"}
          </span>
        </div>
        <RadioGroup
          aria-label={zh ? "明暗模式" : "Color mode"}
          orientation="horizontal"
          className="appearance-mode-group"
          value={mode}
          onChange={(next) => setTheme(next as ThemeMode)}
        >
          {modes.map(({ id, label, Icon }) => (
            <Radio
              key={id}
              value={id}
              aria-label={label}
              className="appearance-mode"
            >
              <Radio.Content>
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
                <Icon size={14} />
                <span>{label}</span>
                <span className="appearance-mode__check">
                  <Check size={11} />
                </span>
              </span>
              </Radio.Content>
            </Radio>
          ))}
        </RadioGroup>
      </div>

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
          <ColorSwatchPicker
            aria-label={zh ? "预设主题色" : "Accent presets"}
            className="appearance-swatches"
            value={accent}
            onChange={changeColor}
          >
            {ACCENT_PRESETS.map((item) => (
              <ColorSwatchPicker.Item
                key={item.color}
                color={item.color}
                aria-label={item[locale]}
              >
                <ColorSwatchPicker.Swatch />
                <ColorSwatchPicker.Indicator>
                  <Check />
                </ColorSwatchPicker.Indicator>
              </ColorSwatchPicker.Item>
            ))}
          </ColorSwatchPicker>
          <div className="appearance-custom-row">
            <ColorPicker value={value} onChange={changeColor}>
              <ColorPicker.Trigger
                className="appearance-custom"
                aria-label={zh ? "自定义主题色" : "Custom accent color"}
              >
                <SlidersHorizontal size={14} />
                <span>{zh ? "调色盘" : "Custom color"}</span>
                <span className="appearance-hex">{accent.toUpperCase()}</span>
              </ColorPicker.Trigger>
              <ColorPicker.Popover
                className="appearance-color-popover"
                placement="bottom start"
                aria-label={zh ? "自定义主题色" : "Custom accent color"}
              >
                <div className="appearance-heading">
                  <span className="appearance-label">
                    {zh ? "自定义主题色" : "Custom accent color"}
                  </span>
                  <ColorSwatch color={value} size="sm" />
                </div>
                <ColorArea
                  aria-label={zh ? "饱和度与亮度" : "Saturation and brightness"}
                  colorSpace="hsb"
                  xChannel="saturation"
                  yChannel="brightness"
                  className="appearance-color-area"
                >
                  <ColorArea.Thumb />
                </ColorArea>
                <ColorSlider
                  channel="hue"
                  colorSpace="hsb"
                  aria-label={zh ? "色相" : "Hue"}
                >
                  <ColorSlider.Track>
                    <ColorSlider.Thumb />
                  </ColorSlider.Track>
                </ColorSlider>
                <ColorField>
                  <Label>{zh ? "HEX 色值" : "HEX color"}</Label>
                  <InputGroup>
                    <InputGroup.Input
                      onKeyDown={(event) => {
                        if (event.key === "Enter") event.currentTarget.blur();
                      }}
                    />
                  </InputGroup>
                </ColorField>
                <p className="appearance-hint">
                  {zh
                    ? "拖动选色，或输入 HEX 色值。"
                    : "Drag to explore, or enter a HEX color."}
                </p>
              </ColorPicker.Popover>
            </ColorPicker>
            <Tooltip delay={300}>
              <Button
                variant="ghost"
                size="sm"
                isIconOnly
                isDisabled={accent === DEFAULT_ACCENT}
                aria-label={zh ? "恢复默认主题色" : "Reset accent color"}
                onPress={() => setAccent(DEFAULT_ACCENT)}
              >
                <RotateCcw size={14} />
              </Button>
              <Tooltip.Content>
                {zh ? "恢复默认主题色" : "Reset accent color"}
              </Tooltip.Content>
            </Tooltip>
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
