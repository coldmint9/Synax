import { Button, Label, Slider, Spinner } from "@heroui/react";
import {
  ImagePlus,
  PanelsTopLeft,
  RotateCcw,
  Trash2,
  Upload,
} from "lucide-react";
import { useLocale } from "../../../../hooks/useLocale";
import {
  desktopAppearanceAPI,
  useDesktopAppearance,
} from "../../../state/desktopAppearanceStore";
import type { BackgroundFit } from "../../../../../../electron/appearance-contract";
import { SettingsCard } from "./SettingsCard";
import { SettingsSelect } from "./SettingsSelect";
import "./desktopAppearance.css";

export function DesktopAppearanceSection() {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const {
    settings,
    error,
    busy,
    load,
    preview,
    update,
    chooseBackground,
    removeBackground,
  } = useDesktopAppearance();
  if (!desktopAppearanceAPI()) return null;
  const background = settings?.background;
  const opacity = settings ? Math.round((1 - settings.opacity) * 100) : 0;
  const errorText = error?.includes("IMAGE_TOO_LARGE")
    ? zh
      ? "图片过大，请选择 20 MB 以内、4000 万像素以内的图片。"
      : "Choose an image under 20 MB and 40 megapixels."
    : error?.includes("INVALID_IMAGE")
      ? zh
        ? "无法读取这张图片，请选择有效的 PNG 或 JPG 文件。"
        : "Choose a valid PNG or JPG image."
      : zh
        ? "暂时无法保存桌面外观，请重试。"
        : "Could not save your desktop appearance. Please try again.";
  return (
    <SettingsCard
      title={zh ? "窗口与背景" : "Window & Background"}
      icon={PanelsTopLeft}
      description={zh ? "桌面专属" : "Desktop only"}
    >
      {!settings ? (
        <div className="desktop-appearance-loading">
          {busy ? (
            <Spinner size="sm" />
          ) : (
            <Button size="sm" variant="secondary" onPress={() => void load()}>
              {zh ? "重新加载" : "Reload"}
            </Button>
          )}
        </div>
      ) : (
        <>
          <div className="desktop-opacity-row">
            <div>
              <div className="appearance-label">
                {zh ? "窗口透明度" : "Window transparency"}
              </div>
              <p className="appearance-hint">
                {settings.opacitySupported
                  ? zh
                    ? "让桌面轻轻透过窗口。0% 为完全不透明。"
                    : "Let your desktop show through. 0% is fully opaque."
                  : zh
                    ? "当前系统不支持原生窗口透明度，仍可自定义背景。"
                    : "Native transparency is unavailable on this system. Backgrounds are still supported."}
              </p>
            </div>
            <div className="desktop-opacity-control">
              <Slider
                aria-label={zh ? "窗口透明度" : "Window transparency"}
                minValue={0}
                maxValue={60}
                step={1}
                value={opacity}
                isDisabled={busy || !settings.opacitySupported}
                onChange={(value) =>
                  preview({ opacity: 1 - Number(value) / 100 })
                }
                onChangeEnd={(value) =>
                  void update({ opacity: 1 - Number(value) / 100 })
                }
              >
                <div className="desktop-slider-heading">
                  <span>{zh ? "不透明" : "Opaque"}</span>
                  <Slider.Output>{opacity}%</Slider.Output>
                </div>
                <Slider.Track>
                  <Slider.Fill />
                  <Slider.Thumb />
                </Slider.Track>
              </Slider>
              <Button
                size="sm"
                variant="ghost"
                isIconOnly
                aria-label={zh ? "恢复不透明窗口" : "Reset window opacity"}
                isDisabled={busy || opacity === 0}
                onPress={() => {
                  preview({ opacity: 1 });
                  void update({ opacity: 1 });
                }}
              >
                <RotateCcw size={14} />
              </Button>
            </div>
          </div>
          <div className="desktop-wallpaper">
            <div
              className="desktop-wallpaper-preview"
              data-has-image={Boolean(background)}
            >
              {background ? (
                <div
                  className="desktop-background__image"
                  data-fit={settings.fit}
                  style={{
                    backgroundImage: `url("${background.url}")`,
                    filter: `blur(${settings.blur / 3}px)`,
                  }}
                />
              ) : (
                <div className="desktop-wallpaper-empty">
                  <ImagePlus size={26} strokeWidth={1.3} />
                  <span>
                    {zh ? "为工作区留一点风景" : "A view of your own"}
                  </span>
                </div>
              )}
              {background && (
                <div className="desktop-wallpaper-preview__caption">
                  {zh ? "背景预览" : "Background preview"}
                </div>
              )}
            </div>
            <div className="desktop-wallpaper-options">
              <div className="appearance-heading">
                <span className="appearance-label">
                  {zh ? "背景图片" : "Background image"}
                </span>
                {busy && <Spinner size="sm" />}
              </div>
              <p className="desktop-wallpaper-name" title={background?.name}>
                {background?.name ??
                  (zh
                    ? "选择喜欢的图片，打造自己的工作空间。"
                    : "Make your workspace feel like your own.")}
              </p>
              <div className="desktop-wallpaper-actions">
                <Button
                  size="sm"
                  variant="secondary"
                  isDisabled={busy}
                  onPress={() => void chooseBackground()}
                >
                  <Upload size={14} />
                  {background
                    ? zh
                      ? "更换图片"
                      : "Change image"
                    : zh
                      ? "选择图片"
                      : "Choose image"}
                </Button>
                {background && (
                  <Button
                    size="sm"
                    variant="ghost"
                    isDisabled={busy}
                    onPress={() => void removeBackground()}
                  >
                    <Trash2 size={14} />
                    {zh ? "移除" : "Remove"}
                  </Button>
                )}
              </div>
              <p className="appearance-hint">
                {zh
                  ? "PNG / JPG · 最大 20 MB · 仅保存在此设备"
                  : "PNG / JPG · Up to 20 MB · Stored on this device"}
              </p>
            </div>
          </div>
          <div className="desktop-background-controls">
            <Slider
              minValue={0}
              maxValue={40}
              step={1}
              value={settings.blur}
              isDisabled={!background || busy}
              onChange={(value) => preview({ blur: Number(value) })}
              onChangeEnd={(value) => void update({ blur: Number(value) })}
            >
              <div className="desktop-slider-heading">
                <Label>{zh ? "背景模糊" : "Background blur"}</Label>
                <Slider.Output>{settings.blur} px</Slider.Output>
              </div>
              <Slider.Track>
                <Slider.Fill />
                <Slider.Thumb />
              </Slider.Track>
            </Slider>
            <div className="desktop-background-fit">
              <span className="appearance-label">
                {zh ? "缩放方式" : "Image fit"}
              </span>
              <SettingsSelect
                className="desktop-background-fit__select"
                selectedKey={settings.fit}
                isDisabled={!background || busy}
                aria-label={zh ? "缩放方式" : "Image fit"}
                disallowEmptySelection
                onSelectionChange={(fit) => {
                  if (fit) {
                    preview({ fit: fit as BackgroundFit });
                    void update({ fit: fit as BackgroundFit });
                  }
                }}
                options={[
                  {
                    key: "cover",
                    label: zh ? "填充（推荐）" : "Fill (recommended)",
                  },
                  { key: "contain", label: zh ? "适应" : "Fit" },
                  { key: "fill", label: zh ? "拉伸" : "Stretch" },
                  { key: "center", label: zh ? "居中" : "Center" },
                  { key: "tile", label: zh ? "平铺" : "Tile" },
                ]}
              />
            </div>
          </div>
        </>
      )}
      {error && (
        <div className="desktop-appearance-error" role="alert">
          {errorText}
        </div>
      )}
    </SettingsCard>
  );
}
