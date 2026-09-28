import { useId, useRef, useState, type PointerEvent } from "react";
import { Popover, PopoverButton, PopoverPanel } from "@headlessui/react";
import { SlidersHorizontal, X } from "lucide-react";
import { DEFAULT_ACCENT } from "../../../../lib/appearance";
import { cssColorToHex, hexToHsv, hsvToHex, normalizeHex, type Hsv } from "./accentColor";
import "./appearance.css";

interface AccentColorPickerProps {
  value: string;
  onChange: (value: string) => void;
  locale: "zh" | "en";
}

interface ColorChannelProps {
  label: string;
  value: number;
  max: number;
  unit: string;
  descriptionId: string;
  hue?: boolean;
  onChange: (value: number) => void;
}

function ColorChannel({
  label,
  value,
  max,
  unit,
  descriptionId,
  hue,
  onChange,
}: ColorChannelProps) {
  const id = useId();
  return (
    <div className="appearance-channel">
      <div className="appearance-heading">
        <label htmlFor={id}>{label}</label>
        <output htmlFor={id} aria-hidden="true">
          {value}
          {unit}
        </output>
      </div>
      <input
        id={id}
        className={`appearance-channel__range${hue ? " appearance-channel__range--hue" : ""}`}
        type="range"
        min={0}
        max={max}
        step={1}
        value={value}
        aria-valuetext={`${value}${unit}`}
        aria-describedby={descriptionId}
        onChange={(event) => onChange(event.currentTarget.valueAsNumber)}
      />
    </div>
  );
}

interface ColorEditorProps {
  value: string;
  previewValue: string;
  hsv: Hsv;
  zh: boolean;
  titleId: string;
  onChange: (value: Hsv) => void;
  onClose: () => void;
}

function ColorEditor({
  value,
  previewValue,
  hsv,
  zh,
  titleId,
  onChange,
  onClose,
}: ColorEditorProps) {
  const id = useId();
  const activePointer = useRef<number | null>(null);
  const [draft, setDraft] = useState(() => ({
    source: value,
    text: value.toUpperCase(),
    invalid: false,
  }));
  // Only external changes (presets, reset, other windows or channels) replace a
  // draft. Our own valid HEX edits record their source before notifying the store.
  if (draft.source !== value) {
    setDraft({ source: value, text: value.toUpperCase(), invalid: false });
  }

  const updateFromPointer = (event: PointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return;
    const s = Math.min(
      1,
      Math.max(0, (event.clientX - rect.left) / rect.width),
    );
    const v = Math.min(
      1,
      Math.max(0, 1 - (event.clientY - rect.top) / rect.height),
    );
    onChange({ ...hsv, s, v });
  };
  const endDrag = (event: PointerEvent<HTMLDivElement>) => {
    if (activePointer.current !== event.pointerId) return;
    activePointer.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };
  const editHex = (text: string) => {
    const hex = normalizeHex(text);
    setDraft({ source: hex ?? value, text, invalid: false });
    if (hex) onChange(hexToHsv(hex, hsv.h));
  };
  const commitHex = () => {
    const hex = normalizeHex(draft.text);
    if (!hex) {
      setDraft({ ...draft, invalid: true });
      return false;
    }
    setDraft({ source: hex, text: hex.toUpperCase(), invalid: false });
    return true;
  };

  return (
    <>
      <div className="appearance-heading">
        <span id={titleId} className="appearance-label">
          {zh ? "自定义主题色" : "Custom accent color"}
        </span>
        <div className="appearance-editor-actions">
          <span
            className="appearance-color-preview"
            style={{ backgroundColor: previewValue }}
            aria-hidden="true"
          />
          <button
            type="button"
            className="appearance-icon-button"
            aria-label={zh ? "关闭调色盘" : "Close color editor"}
            onClick={onClose}
          >
            <X size={16} aria-hidden="true" />
          </button>
        </div>
      </div>
      <div
        role="group"
        aria-label={zh ? "饱和度与亮度" : "Saturation and brightness"}
        aria-describedby={`${id}-area-help`}
        className="appearance-color-area"
        style={{ backgroundColor: hsvToHex({ h: hsv.h, s: 1, v: 1 }) }}
        onPointerDown={(event) => {
          if (
            event.button !== 0 ||
            !event.isPrimary ||
            activePointer.current !== null
          )
            return;
          event.preventDefault();
          activePointer.current = event.pointerId;
          event.currentTarget.setPointerCapture(event.pointerId);
          updateFromPointer(event);
        }}
        onPointerMove={(event) => {
          if (activePointer.current === event.pointerId)
            updateFromPointer(event);
        }}
        onPointerUp={(event) => {
          if (activePointer.current !== event.pointerId) return;
          updateFromPointer(event);
          endDrag(event);
        }}
        onPointerCancel={endDrag}
        onLostPointerCapture={(event) => {
          if (activePointer.current === event.pointerId)
            activePointer.current = null;
        }}
      >
        <span
          aria-hidden="true"
          className="appearance-color-area__thumb"
          style={{
            left: `${hsv.s * 100}%`,
            top: `${(1 - hsv.v) * 100}%`,
            backgroundColor: value,
          }}
        />
      </div>
      <p id={`${id}-area-help`} className="appearance-visually-hidden">
        {zh
          ? "拖动选色，或使用下方的饱和度与亮度滑块。"
          : "Drag to select a color, or use the saturation and brightness sliders below."}
      </p>
      <div className="appearance-channels">
        <ColorChannel
          label={zh ? "色相" : "Hue"}
          hue
          value={Math.min(359, Math.round(hsv.h))}
          max={359}
          unit="°"
          descriptionId={`${id}-channel-help`}
          onChange={(h) => onChange({ ...hsv, h })}
        />
        <ColorChannel
          label={zh ? "饱和度" : "Saturation"}
          value={Math.round(hsv.s * 100)}
          max={100}
          unit="%"
          descriptionId={`${id}-channel-help`}
          onChange={(s) => onChange({ ...hsv, s: s / 100 })}
        />
        <ColorChannel
          label={zh ? "亮度" : "Brightness"}
          value={Math.round(hsv.v * 100)}
          max={100}
          unit="%"
          descriptionId={`${id}-channel-help`}
          onChange={(v) => onChange({ ...hsv, v: v / 100 })}
        />
      </div>
      <p id={`${id}-channel-help`} className="appearance-visually-hidden">
        {zh
          ? "使用方向键微调；Home / End 跳至最小 / 最大值。"
          : "Use arrow keys to adjust; Home / End select the minimum / maximum."}
      </p>
      <div className="appearance-hex-field">
        <label htmlFor={`${id}-hex`}>{zh ? "HEX 色值" : "HEX color"}</label>
        <input
          id={`${id}-hex`}
          type="text"
          value={draft.text}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="off"
          aria-invalid={draft.invalid || undefined}
          aria-describedby={`${id}-hex-help${draft.invalid ? ` ${id}-hex-error` : ""}`}
          onChange={(event) => editHex(event.currentTarget.value)}
          onBlur={commitHex}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              commitHex();
            }
          }}
        />
        <p id={`${id}-hex-help`} className="appearance-hint">
          {zh
            ? "输入 3 或 6 位 HEX 色值。有效颜色即时保存；Esc 取消未完成的输入。"
            : "Enter 3 or 6 HEX digits. Valid colors save instantly; Esc cancels unfinished input."}
        </p>
        {draft.invalid && (
          <p
            id={`${id}-hex-error`}
            role="alert"
            className="appearance-color-error"
          >
            {zh
              ? "请输入有效的 3 或 6 位 HEX 色值。"
              : "Enter a valid 3 or 6 digit HEX color."}
          </p>
        )}
      </div>
    </>
  );
}

export function AccentColorPicker({
  value,
  onChange,
  locale,
}: AccentColorPickerProps) {
  const titleId = useId();
  const zh = locale === "zh";
  // The editor only speaks HEX, but the active semantic accent may be any
  // supported CSS color. Keep the semantic value for preview and convert only
  // the editor/HSV representation.
  const hex = cssColorToHex(value) ?? DEFAULT_ACCENT;
  const [color, setColor] = useState(() => ({ hex, hsv: hexToHsv(hex) }));
  // Keep HSV outside the unmounted panel: HEX loses hue at zero saturation and
  // both hue and saturation at black. Reconcile only genuinely external colors.
  if (color.hex !== hex) setColor({ hex, hsv: hexToHsv(hex, color.hsv.h) });
  const changeColor = (hsv: Hsv) => {
    const next = hsvToHex(hsv);
    setColor({ hex: next, hsv });
    onChange(next);
  };

  return (
    <Popover className="appearance-picker">
      <PopoverButton
        className="appearance-custom"
        aria-label={zh ? "自定义主题色" : "Custom accent color"}
        aria-haspopup="dialog"
      >
        <SlidersHorizontal size={14} aria-hidden="true" />
        <span>{zh ? "调色盘" : "Custom color"}</span>
        <span className="appearance-hex">{hex.toUpperCase()}</span>
      </PopoverButton>
      <PopoverPanel
        focus
        anchor={{ to: "bottom start", gap: 8, padding: 12 }}
        role="dialog"
        aria-labelledby={titleId}
        className="appearance-color-popover"
      >
        {({ close }) => (
          <ColorEditor
            value={hex}
            previewValue={value}
            hsv={color.hsv}
            zh={zh}
            titleId={titleId}
            onChange={changeColor}
            onClose={() => close()}
          />
        )}
      </PopoverPanel>
    </Popover>
  );
}
