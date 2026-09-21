/** Environment-neutral artifact wire types. Never import runtime code into a preview. */
export type ArtifactKind = "html" | "react";
export interface ArtifactReference {
  type: "artifact";
  artifactId: string;
  revisionId: string;
  title: string;
  presentation: "inline" | "wide";
}
export interface ArtifactPublishInput {
  sourcePath: string;
  title: string;
  sourceKind: ArtifactKind;
  artifactId?: string;
  baseRevisionId?: string;
  idempotencyKey: string;
}
export interface ArtifactFile {
  path: string;
  content: string;
  encoding: "utf8" | "base64";
  mediaType: string;
}
export interface ArtifactRevision extends ArtifactReference {
  sessionId: string;
  revisionNumber: number;
  sourceKind: ArtifactKind;
  sourcePath: string;
  sourceHash: string;
  bundleHash: string;
  createdAt: string;
  status: "building" | "ready" | "failed";
  diagnostics: string[];
  baseRevisionId: string | null;
  runId: string | null;
  turnId: string | null;
}
export interface ArtifactBundle {
  revision: ArtifactRevision;
  html: string;
}
export interface ArtifactState {
  privateState: unknown;
  modelState: unknown;
  controls: Record<string, unknown>;
  etag: number;
  schemaVersion: number;
}
export interface ArtifactFeedbackInput {
  text: string;
  parameters?: Record<string, unknown>;
  modelState?: unknown;
  element?: {
    qaId?: string;
    tag: string;
    text: string;
    bounds?: ArtifactElementBounds;
  };
  screenshots?: Array<{ assetId: string; previewConfirmed: true }>;
  idempotencyKey: string;
}
export interface ArtifactControl {
  key: string;
  label: string;
  type: "select" | "toggle" | "range" | "number" | "color" | "text";
  defaultValue: string | number | boolean;
  options?: Array<{ label: string; value: string }>;
  min?: number;
  max?: number;
  step?: number;
}
export interface ArtifactPublishContext {
  sessionId: string;
  projectId: string;
  workspaceRoot: string;
  signal?: AbortSignal;
  jobId?: string;
  runId?: string | null;
  turnId?: string | null;
}
export const ARTIFACT_LIMITS = {
  textBytes: 2 * 1024 * 1024,
  assetBytes: 20 * 1024 * 1024,
  bundleBytes: 10 * 1024 * 1024,
  files: 100,
  stateBytes: 16 * 1024,
  messageBytes: 32 * 1024,
  controls: 12,
  sessionBytes: 500 * 1024 * 1024,
  totalBytes: 2 * 1024 * 1024 * 1024,
  buildMs: 15000,
} as const;
export class ArtifactError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
    this.name = "ArtifactError";
  }
}
export const emptyArtifactState = (): ArtifactState => ({
  privateState: null,
  modelState: null,
  controls: {},
  etag: 0,
  schemaVersion: 1,
});

export interface ArtifactBuildJob {
  jobId: string;
  sessionId: string;
  title: string;
  status: "queued" | "building" | "ready" | "failed" | "cancelled";
  revisionId: string | null;
  artifactId: string | null;
  errorCode: string | null;
  diagnostics: string[];
  createdAt: string;
  updatedAt: string;
  attempt: number;
}

export interface ArtifactElementBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
}
