import { useEffect, type CSSProperties } from "react";
import { useDesktopAppearance } from "../state/desktopAppearanceStore";
import "./desktopBackground.css";

export function DesktopBackground() {
  const settings = useDesktopAppearance((s) => s.settings);
  const image = settings?.background;
  useEffect(() => {
    document.documentElement.classList.toggle(
      "has-desktop-background",
      Boolean(image),
    );
    return () =>
      document.documentElement.classList.remove("has-desktop-background");
  }, [image?.url]);
  if (!image || !settings) return null;
  return (
    <div className="desktop-background" aria-hidden="true">
      <div
        className="desktop-background__image"
        data-fit={settings.fit}
        style={
          {
            backgroundImage: `url("${image.url}")`,
            "--background-blur": `${settings.blur}px`,
          } as CSSProperties
        }
      />
    </div>
  );
}
