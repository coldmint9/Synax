export type BackgroundFit = "cover" | "contain" | "fill" | "center" | "tile";

export interface DesktopAppearancePatch {
  opacity?: number;
  blur?: number;
  fit?: BackgroundFit;
}

export interface DesktopAppearance {
  opacity: number;
  blur: number;
  fit: BackgroundFit;
  opacitySupported: boolean;
  background: {
    asset: string;
    name: string;
    width: number;
    height: number;
    url: string;
  } | null;
}

export interface DesktopAppearanceAPI {
  get: () => Promise<DesktopAppearance>;
  update: (patch: DesktopAppearancePatch) => Promise<DesktopAppearance>;
  previewOpacity: (opacity: number) => void;
  chooseBackground: () => Promise<DesktopAppearance | null>;
  removeBackground: () => Promise<DesktopAppearance>;
}
