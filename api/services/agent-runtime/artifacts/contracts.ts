export type ArtifactKind = "html" | "react";
export interface ArtifactFile {
  path: string;
  content: string;
  encoding: "utf8" | "base64";
  mediaType: string;
}
export const ARTIFACT_LIMITS = {
  textBytes: 2 * 1024 * 1024,
  assetBytes: 20 * 1024 * 1024,
  bundleBytes: 10 * 1024 * 1024,
  files: 100,
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
