import type { BrowserWindow } from "electron";

export type MacWindowVibrancy = "under-window" | "hud-window" | "none";

export interface MacWindowAppearance {
  enabled: boolean;
  vibrancy: MacWindowVibrancy;
  opacity: number;
  bottomSeparator: boolean;
  scanlines: boolean;
  scanlineOpacity: number;
}

export const DEFAULT_MAC_WINDOW_APPEARANCE: MacWindowAppearance = {
  enabled: false,
  vibrancy: "under-window",
  opacity: 0.82,
  bottomSeparator: true,
  scanlines: false,
  scanlineOpacity: 0.025,
};

export function normalizeMacWindowAppearance(
  value: Partial<MacWindowAppearance> | null | undefined,
): MacWindowAppearance {
  const vibrancy = value?.vibrancy;
  return {
    enabled: value?.enabled ?? DEFAULT_MAC_WINDOW_APPEARANCE.enabled,
    vibrancy:
      vibrancy === "hud-window" || vibrancy === "none"
        ? vibrancy
        : DEFAULT_MAC_WINDOW_APPEARANCE.vibrancy,
    opacity: clamp(value?.opacity ?? DEFAULT_MAC_WINDOW_APPEARANCE.opacity, 0.35, 1),
    bottomSeparator:
      value?.bottomSeparator ?? DEFAULT_MAC_WINDOW_APPEARANCE.bottomSeparator,
    scanlines: value?.scanlines ?? DEFAULT_MAC_WINDOW_APPEARANCE.scanlines,
    scanlineOpacity: clamp(
      value?.scanlineOpacity ?? DEFAULT_MAC_WINDOW_APPEARANCE.scanlineOpacity,
      0,
      0.08,
    ),
  };
}

/** Also used by theme/menu updates: never repaint an enabled glass window solid. */
export function windowBackgroundColor(
  appearance: Partial<MacWindowAppearance> | null | undefined,
  dark: boolean,
): string {
  if (process.platform === "darwin" && appearance?.enabled === true) return "#00000000";
  return dark ? "#0f141d" : "#f9f9f9";
}

export function applyMacWindowAppearance(
  win: BrowserWindow,
  value: Partial<MacWindowAppearance> | null | undefined,
  dark = false,
): MacWindowAppearance {
  const appearance = normalizeMacWindowAppearance(value);
  if (process.platform !== "darwin") return appearance;

  const effectiveVibrancy = appearance.enabled ? appearance.vibrancy : "none";
  win.setVibrancy(
    effectiveVibrancy === "none"
      ? null
      : effectiveVibrancy === "hud-window"
        ? "hud"
        : effectiveVibrancy,
  );
  // Keep text and controls opaque. The renderer controls background alpha so
  // the native vibrancy remains adjustable without fading the whole window.
  win.setOpacity(1);
  win.setBackgroundColor(windowBackgroundColor(appearance, dark));
  return appearance;
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
}
