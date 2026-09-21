export interface UpdaterRequest {
  currentVersion: string;
  uiVersion: string | null;
  executable: string;
  profile: string;
  parentPid: number;
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
