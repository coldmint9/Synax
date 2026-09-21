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
export interface ArtifactPreviewAPI {
  create(input: ArtifactCreate): Promise<void>;
  update(input: ArtifactUpdate): Promise<void>;
  send(input: ArtifactMessageEvent): Promise<void>;
  destroy(id: string): Promise<void>;
  onMessage(listener: (event: ArtifactMessageEvent) => void): () => void;
}
