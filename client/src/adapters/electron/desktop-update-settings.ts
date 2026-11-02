import type { UpdateSettings } from "../../../../electron/updater/update-settings";

export type { UpdateSettings };

export interface DesktopUpdateSettingsApi {
  getUpdateSettings(): Promise<UpdateSettings>;
  setUpdateSettings(settings: UpdateSettings): Promise<UpdateSettings>;
}

export function getDesktopUpdateSettingsApi():
  | DesktopUpdateSettingsApi
  | undefined {
  const api = (
    window as Window & { electronAPI?: Partial<DesktopUpdateSettingsApi> }
  ).electronAPI;
  return typeof api?.getUpdateSettings === "function" &&
    typeof api?.setUpdateSettings === "function"
    ? (api as DesktopUpdateSettingsApi)
    : undefined;
}
