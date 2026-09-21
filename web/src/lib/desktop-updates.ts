import type { UpdaterState } from "../../../electron/updater/contract";
export type { UpdaterState };

export interface DesktopUpdatesApi {
  getDesktopUpdateState(): Promise<UpdaterState | null>;
  onDesktopUpdateState(callback: (state: UpdaterState) => void): () => void;
  onDesktopUpdateShow(callback: () => void): () => void;
  checkDesktopUpdate(): Promise<void>;
  installDesktopUpdate(): Promise<void>;
}

export function getDesktopUpdatesApi(): DesktopUpdatesApi | undefined {
  const api = (window as Window & { electronAPI?: Partial<DesktopUpdatesApi> })
    .electronAPI;
  return api &&
    [
      api.getDesktopUpdateState,
      api.onDesktopUpdateState,
      api.onDesktopUpdateShow,
      api.checkDesktopUpdate,
      api.installDesktopUpdate,
    ].every((method) => typeof method === "function")
    ? (api as DesktopUpdatesApi)
    : undefined;
}
