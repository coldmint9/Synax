import type { BrowserWindow } from "electron";

const TRAFFIC_LIGHT_DIAMETER = 14;
export const DEFAULT_TRAFFIC_LIGHT_POSITION = { x: 14, y: 17 };

/** The renderer reports its toolbar center in viewport CSS pixels. */
export function alignMacWindowButtons(win: BrowserWindow, centerY: unknown): boolean {
  if (process.platform !== "darwin" || win.isDestroyed() ||
      typeof centerY !== "number" || !Number.isFinite(centerY) || centerY < 7 || centerY > 256) {
    return false;
  }
  win.setWindowButtonPosition({
    x: DEFAULT_TRAFFIC_LIGHT_POSITION.x,
    y: Math.max(0, Math.round(centerY * win.webContents.getZoomFactor() - TRAFFIC_LIGHT_DIAMETER / 2)),
  });
  return true;
}
