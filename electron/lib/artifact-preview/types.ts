/** Desktop-only transport types. Keep free of frontend/API dependencies. */
export interface ArtifactRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
export interface ArtifactBounds extends ArtifactRect {
  clip?: ArtifactRect;
}
export interface ArtifactCreate {
  id: string;
  html: string;
  revisionId: string;
  nonce: string;
  bounds: ArtifactBounds;
}
export interface ArtifactUpdate {
  id: string;
  bounds: ArtifactBounds;
  visible: boolean;
}
export interface ArtifactMessageEvent {
  id: string;
  message: Record<string, unknown>;
}
export interface ArtifactElementBounds extends ArtifactRect {
  viewportWidth: number;
  viewportHeight: number;
}
export interface ArtifactCaptureRequest {
  id: string;
  revisionId: string;
}
export interface ArtifactCaptureResult extends ArtifactCaptureRequest {
  mimeType: "image/png";
  bytes: Uint8Array;
  width: number;
  height: number;
}
export interface ArtifactAnnotationRequest extends ArtifactCaptureRequest {
  bounds: ArtifactElementBounds | null;
}
export interface ArtifactPreviewAPI {
  capture(input: ArtifactCaptureRequest): Promise<ArtifactCaptureResult>;
  annotate(input: ArtifactAnnotationRequest): Promise<void>;
  create(input: ArtifactCreate): Promise<void>;
  update(input: ArtifactUpdate): Promise<void>;
  send(input: ArtifactMessageEvent): Promise<void>;
  destroy(id: string): Promise<void>;
  onMessage(listener: (event: ArtifactMessageEvent) => void): () => void;
}
