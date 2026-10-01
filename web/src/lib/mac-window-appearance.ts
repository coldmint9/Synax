import type { MacWindowAppearance } from "./contracts/config";

export const DEFAULT_MAC_WINDOW_APPEARANCE: MacWindowAppearance = {
  enabled: false,
  vibrancy: "under-window",
  opacity: 0.82,
  bottomSeparator: true,
  scanlines: false,
  scanlineOpacity: 0.025,
};

export function desktopWindowApi() {
  return (window as Window & {
    electronAPI?: {
      platform?: string;
      setMacWindowAppearance?: (value: MacWindowAppearance) => Promise<MacWindowAppearance>;
    };
  }).electronAPI;
}

/** Window-wide state, not a settings-page effect. Keep it when routes unmount. */
export async function applyMacWindowAppearance(value: MacWindowAppearance): Promise<void> {
  const api = desktopWindowApi();
  if (api?.platform !== "darwin") return;
  const root = document.documentElement;
  root.dataset.macWindowEnabled = String(value.enabled);
  root.dataset.macWindowSeparator = String(value.enabled && value.bottomSeparator);
  root.dataset.macWindowScanlines = String(value.enabled && value.scanlines);
  root.style.setProperty("--mac-window-opacity", String(value.opacity));
  root.style.setProperty("--mac-scanline-opacity", String(value.scanlineOpacity));
  await api.setMacWindowAppearance?.(value);
}
