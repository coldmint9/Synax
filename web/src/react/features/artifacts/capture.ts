import { apiFetch } from "../../../lib/api/origin";

export interface ArtifactElementBounds {
  x: number;
  y: number;
  width: number;
  height: number;
  viewportWidth: number;
  viewportHeight: number;
}
export interface ArtifactCaptureResult {
  id: string;
  revisionId: string;
  mimeType: "image/png";
  bytes: Uint8Array;
  width: number;
  height: number;
}
/** Host-only state. Never serialize previewUrl or image bytes into feedback. */
export interface ArtifactScreenshot {
  assetId: string;
  previewConfirmed: true;
  previewUrl: string;
}
export const MAX_SCREENSHOT_BYTES = 4 * 1024 * 1024;
export function screenshotBlob(
  capture: ArtifactCaptureResult,
  revisionId: string,
): Blob {
  const bytes = capture.bytes;
  if (
    capture.revisionId !== revisionId ||
    capture.mimeType !== "image/png" ||
    !(bytes instanceof Uint8Array) ||
    bytes.length < 33 ||
    bytes.length > MAX_SCREENSHOT_BYTES ||
    ![137, 80, 78, 71, 13, 10, 26, 10].every((v, i) => bytes[i] === v)
  )
    throw new Error("Invalid or stale artifact screenshot.");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16),
    height = view.getUint32(20);
  if (
    view.getUint32(8) !== 13 ||
    view.getUint32(12) !== 0x49484452 ||
    !width ||
    !height ||
    width > 4096 ||
    height > 4096 ||
    width !== capture.width ||
    height !== capture.height
  )
    throw new Error("Invalid screenshot dimensions.");
  return new Blob([new Uint8Array(bytes)], { type: "image/png" });
}
/** Binary multipart upload only; credentials and desktop auth come from apiFetch. */
export async function uploadArtifactScreenshot(
  sessionId: string,
  revisionId: string,
  capture: ArtifactCaptureResult,
): Promise<{ assetId: string }> {
  const form = new FormData();
  form.append(
    "file",
    screenshotBlob(capture, revisionId),
    "artifact-screenshot.png",
  );
  const response = await apiFetch(
    `/api/agent-runtime/sessions/${encodeURIComponent(sessionId)}/artifacts/revisions/${encodeURIComponent(revisionId)}/screenshots`,
    {
      method: "POST",
      headers: { "X-Synax-Artifact-Action": "capture-screenshot" },
      body: form,
    },
  );
  if (!response.ok)
    throw new Error(`Screenshot upload failed (${response.status}).`);
  const result = (await response.json()) as { asset?: { id?: unknown } };
  if (
    typeof result.asset?.id !== "string" ||
    !/^asset_[a-f0-9]{32}$/.test(result.asset.id)
  )
    throw new Error("Invalid screenshot upload response.");
  return { assetId: result.asset.id };
}
export function screenshotFeedback(screenshot: ArtifactScreenshot | null) {
  return screenshot
    ? [{ assetId: screenshot.assetId, previewConfirmed: true as const }]
    : undefined;
}
export function revokeScreenshot(screenshot: ArtifactScreenshot | null): void {
  if (screenshot) URL.revokeObjectURL(screenshot.previewUrl);
}
export function validElementBounds(bounds: ArtifactElementBounds): boolean {
  return (
    [
      bounds.x,
      bounds.y,
      bounds.width,
      bounds.height,
      bounds.viewportWidth,
      bounds.viewportHeight,
    ].every((v) => Number.isFinite(v) && v >= 0 && v <= 16384) &&
    bounds.width > 0 &&
    bounds.height > 0 &&
    bounds.viewportWidth > 0 &&
    bounds.viewportHeight > 0 &&
    bounds.x + bounds.width <= bounds.viewportWidth &&
    bounds.y + bounds.height <= bounds.viewportHeight
  );
}
