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
  enabled: true,
  vibrancy: "under-window",
  opacity: 0.92,
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
    opacity: clamp(value?.opacity ?? DEFAULT_MAC_WINDOW_APPEARANCE.opacity, 0.75, 1),
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

export function applyMacWindowAppearance(
  win: BrowserWindow,
  value: Partial<MacWindowAppearance> | null | undefined,
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
  win.setOpacity(appearance.enabled ? appearance.opacity : 1);
  return appearance;
}

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : min;
}
