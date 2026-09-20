export type BackgroundFit = "cover" | "contain" | "fill" | "center" | "tile";

export interface DesktopAppearancePatch {
  /** Opacity of the background plane, never the native window or UI. */
  opacity?: number;
  blur?: number;
  frost?: number;
  fit?: BackgroundFit;
}

export interface DesktopAppearance {
  opacity: number;
  blur: number;
  frost: number;
  fit: BackgroundFit;
  opacitySupported: boolean;
  /** Absent on older desktop hosts that still use whole-window opacity. */
  layeredBackground?: boolean;
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
  chooseBackground: () => Promise<DesktopAppearance | null>;
  removeBackground: () => Promise<DesktopAppearance>;
}
