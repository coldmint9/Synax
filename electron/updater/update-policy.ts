import { currentUpdateSettings } from "./update-settings.js";

/** Online updates are opt-in: the installer never enables them by itself. */
export const ONLINE_UPDATES_DISABLED_MESSAGE =
  "在线更新已关闭，可在「设置 → 在线更新」中开启。";

export function onlineUpdatesEnabled(): boolean {
  return currentUpdateSettings().enabled;
}

export function requireOnlineUpdates(): void {
  if (!onlineUpdatesEnabled()) throw new Error(ONLINE_UPDATES_DISABLED_MESSAGE);
}
