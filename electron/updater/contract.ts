export interface UpdaterRequest {
  format: 1;
  currentVersion: string;
  uiVersion: string | null;
  executable: string;
  profile: string;
  parentPid: number;
  controlUrl: string;
  token: string;
  background: boolean;
}
export type UpdatePhase =
  | "idle"
  | "checking"
  | "current"
  | "available"
  | "downloading"
  | "ready"
  | "installing"
  | "complete"
  | "error";
export interface UpdateHistory {
  version: string;
  fromVersion: string;
  at: string;
  outcome: "installed" | "failed";
}
export interface UpdaterState {
  phase: UpdatePhase;
  currentVersion: string;
  uiVersion: string | null;
  availableVersion: string | null;
  size: number;
  progress: number;
  notes: string;
  message: string;
  history: UpdateHistory[];
}
export type UpdaterAction =
  | "check"
  | "download"
  | "install"
  | "release"
  | "ui-check";
export function validateUpdaterRequest(value: unknown): UpdaterRequest {
  const data = value as UpdaterRequest;
  if (
    !data ||
    data.format !== 1 ||
    typeof data.currentVersion !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(data.currentVersion) ||
    typeof data.executable !== "string" ||
    typeof data.profile !== "string" ||
    !Number.isSafeInteger(data.parentPid) ||
    data.parentPid <= 0 ||
    typeof data.token !== "string" ||
    !/^[a-f0-9]{64}$/.test(data.token) ||
    typeof data.background !== "boolean"
  )
    throw new Error("Invalid embedded updater request");
  const url = new URL(data.controlUrl);
  if (
    url.protocol !== "http:" ||
    url.hostname !== "127.0.0.1" ||
    !url.port ||
    url.username ||
    url.password ||
    url.pathname !== "/"
  )
    throw new Error("Invalid updater control endpoint");
  return data;
}
