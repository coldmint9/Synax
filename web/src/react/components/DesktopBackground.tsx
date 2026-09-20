import { memo, useLayoutEffect, type CSSProperties } from "react";
import { useDesktopAppearance } from "../state/desktopAppearanceStore";
import type { BackgroundFit } from "../../../../electron/appearance-contract";
import "./desktopBackground.css";

// Opacity drags reuse the image layer; only its compositor opacity changes.
const BackgroundImage = memo(function BackgroundImage({
  url,
  fit,
  blur,
}: {
  url: string;
  fit: BackgroundFit;
  blur: number;
}) {
  return (
    <div
      className="desktop-background__image"
      data-fit={fit}
      style={
        {
          backgroundImage: `url("${url}")`,
          "--background-blur": `${blur}px`,
        } as CSSProperties
      }
    />
  );
});

export function DesktopBackground() {
  const settings = useDesktopAppearance((s) => s.settings);
  const image = settings?.background;
  const layered = Boolean(settings?.layeredBackground);
  const visible = layered || Boolean(image);
  const nativeMaterial = layered && Boolean(settings?.opacitySupported);
  useLayoutEffect(() => {
    const root = document.documentElement;
    root.classList.toggle("has-desktop-background", Boolean(image));
    root.classList.toggle("has-desktop-surface", visible);
    root.classList.toggle("has-native-background", nativeMaterial);
    return () =>
      root.classList.remove(
        "has-desktop-background",
        "has-desktop-surface",
        "has-native-background",
      );
  }, [Boolean(image), visible, nativeMaterial]);
  if (!visible || !settings) return null;
  const frost = (settings.frost ?? 50) / 100;
  return (
    <div
      className="desktop-background"
      aria-hidden="true"
      style={
        {
          "--background-opacity": settings.opacity,
          "--background-frost-tint": 0.12 + frost * 0.56,
        } as CSSProperties
      }
    >
      <div className="desktop-background__paint">
        {image && (
          <BackgroundImage
            url={image.url}
            fit={settings.fit}
            blur={Math.min(48, settings.blur + frost * 24)}
          />
        )}
      </div>
    </div>
  );
}
