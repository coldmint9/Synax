import type { UpdateNetworkSettings } from "../../../electron/lib/update-network";

export type { UpdateNetworkSettings };

export interface DesktopUpdateSettingsApi {
  getUpdateNetworkSettings(): Promise<UpdateNetworkSettings>;
  setUpdateNetworkSettings(
    settings: UpdateNetworkSettings,
  ): Promise<UpdateNetworkSettings>;
}

export function getDesktopUpdateSettingsApi():
  | DesktopUpdateSettingsApi
  | undefined {
  const api = (
    window as Window & { electronAPI?: Partial<DesktopUpdateSettingsApi> }
  ).electronAPI;
  return typeof api?.getUpdateNetworkSettings === "function" &&
    typeof api?.setUpdateNetworkSettings === "function"
    ? (api as DesktopUpdateSettingsApi)
    : undefined;
}
