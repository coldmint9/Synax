import { fail, parseId } from "./policy.js";
import type { ArtifactCaptureRequest, ArtifactElementBounds } from "./types.js";

export const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
export const MAX_CAPTURE_DIMENSION = 4096;
export function parseCaptureRequest(input: unknown): ArtifactCaptureRequest {
  if (!input || typeof input !== "object" || Array.isArray(input))
    return fail();
  const v = input as Record<string, unknown>;
  return { id: parseId(v.id), revisionId: parseId(v.revisionId) };
}
export function parseElementBounds(
  input: unknown,
): ArtifactElementBounds | null {
  if (input === null) return null;
  if (!input || typeof input !== "object" || Array.isArray(input))
    return fail();
  const v = input as ArtifactElementBounds;
  for (const key of [
    "x",
    "y",
    "width",
    "height",
    "viewportWidth",
    "viewportHeight",
  ] as const)
    if (!Number.isFinite(v[key]) || v[key] < 0 || v[key] > 16384) fail();
  if (
    !v.width ||
    !v.height ||
    !v.viewportWidth ||
    !v.viewportHeight ||
    v.x + v.width > v.viewportWidth ||
    v.y + v.height > v.viewportHeight
  )
    fail();
  return {
    x: v.x,
    y: v.y,
    width: v.width,
    height: v.height,
    viewportWidth: v.viewportWidth,
    viewportHeight: v.viewportHeight,
  };
}
/** Inspect the encoded image, not DIP dimensions (which vary across Electron versions). */
export function boundedPng(bytes: Buffer): { width: number; height: number } {
  if (bytes.length > MAX_CAPTURE_BYTES) return fail("RESOURCE_LIMIT");
  if (
    bytes.length < 33 ||
    !bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
    bytes.readUInt32BE(8) !== 13 ||
    bytes.toString("ascii", 12, 16) !== "IHDR"
  )
    return fail();
  const width = bytes.readUInt32BE(16),
    height = bytes.readUInt32BE(20);
  if (
    !width ||
    !height ||
    width > MAX_CAPTURE_DIMENSION ||
    height > MAX_CAPTURE_DIMENSION
  )
    return fail("RESOURCE_LIMIT");
  return { width, height };
}
