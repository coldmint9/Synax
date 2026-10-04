import type { Candidate } from './jev-decision.js';

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function finitePositive(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value > 0; }
function finiteNumber(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value); }

/** Maps a source screenshot pixel to the Driver action coordinate space. */
type CoordinateMapper = (x: number, y: number) => { x: number; y: number };

/**
 * The Driver encodes the source-pixel to action-coordinate mapping as
 * `screenshot_pixels` (identity), `scaled_top_left`, or `affine`
 * (`action = m * pixel + t`). Driver 0.30.x emits `affine`, so an unknown space
 * is refused rather than guessed.
 */
function coordinateMapper(coordinates: Record<string, unknown> | null): CoordinateMapper | null {
  const kind = String(coordinates?.kind ?? '');
  if (kind === 'screenshot_pixels') return (x, y) => ({ x, y });
  if (kind === 'scaled_top_left') {
    const unitsX = coordinates?.action_units_per_pixel_x;
    const unitsY = coordinates?.action_units_per_pixel_y;
    const originX = coordinates?.action_origin_x;
    const originY = coordinates?.action_origin_y;
    if (!finitePositive(unitsX) || !finitePositive(unitsY) || !finiteNumber(originX) || !finiteNumber(originY)) return null;
    return (x, y) => ({ x: originX + x * unitsX, y: originY + y * unitsY });
  }
  if (kind === 'affine') {
    const m11 = coordinates?.m11, m12 = coordinates?.m12, m21 = coordinates?.m21, m22 = coordinates?.m22;
    const tx = coordinates?.tx, ty = coordinates?.ty;
    if (!finiteNumber(m11) || !finiteNumber(m12) || !finiteNumber(m21) || !finiteNumber(m22) ||
        !finiteNumber(tx) || !finiteNumber(ty)) return null;
    return (x, y) => ({ x: m11 * x + m12 * y + tx, y: m21 * x + m22 * y + ty });
  }
  return null;
}

type CandidateArgs = { captureId: string; x: number; y: number };

/**
 * Shared, fail-closed walk over one immutable parse result: only the exact
 * capture, the exact source, in-bounds regions, and unique high-confidence
 * interactive labels become candidates.
 */
function collectCandidates(
  payload: unknown,
  captureId: string,
  matchesSource: (source: Record<string, unknown>) => boolean,
  toArgs: (args: CandidateArgs) => Record<string, unknown>,
  mismatchMessage: string,
): Candidate[] {
  const root = object(payload), capture = object(root?.capture), source = object(capture?.source);
  const screenshot = object(capture?.screenshot);
  if (root?.schema !== 'cua.visual_regions_v1' || capture?.capture_id !== captureId || !source || !matchesSource(source) ||
      screenshot?.mime_type !== 'image/png' || typeof screenshot.reference !== 'string' || !screenshot.reference ||
      !finitePositive(screenshot.width) || !finitePositive(screenshot.height) || !Array.isArray(root.regions))
    throw new Error(mismatchMessage);
  const map = coordinateMapper(object(capture?.action_coordinate_space));
  if (!map) throw new Error('Visual region coordinate mapping is invalid');
  const screenshotWidth = screenshot.width, screenshotHeight = screenshot.height;
  if (root.regions.length > 100) throw new Error('Visual region result exceeds the limit');
  const seenIds = new Set<string>(), labels = new Set<string>();
  const candidates: Candidate[] = [];
  for (const item of root.regions) {
    const region = object(item), bounds = object(region?.bounds);
    const id = region?.id;
    const label = typeof region?.text === 'string' ? region.text.trim() : typeof region?.label === 'string' ? region.label.trim() : '';
    if (typeof id !== 'string' || !id || seenIds.has(id) || !['text', 'icon'].includes(String(region?.kind)) ||
        !label || !bounds || !Number.isInteger(bounds.x) || !Number.isInteger(bounds.y) ||
        !Number.isInteger(bounds.width) || !Number.isInteger(bounds.height) ||
        (bounds.x as number) < 0 || (bounds.y as number) < 0 || !finitePositive(bounds.width) || !finitePositive(bounds.height) ||
        (bounds.x as number) + bounds.width > screenshotWidth ||
        (bounds.y as number) + bounds.height > screenshotHeight ||
        typeof region?.confidence !== 'number' || !Number.isFinite(region.confidence) ||
        region.confidence < 0 || region.confidence > 1 || typeof region.interactive !== 'boolean')
      throw new Error('Visual region result is malformed, ambiguous, or out of bounds');
    seenIds.add(id);
    if (!region.interactive || region.confidence < 0.8 || labels.has(label.toLowerCase())) continue;
    labels.add(label.toLowerCase());
    const center = map((bounds.x as number) + bounds.width / 2, (bounds.y as number) + bounds.height / 2);
    candidates.push({
      id: `visual_${candidates.length}`,
      description: `Click the unique visual ${region.kind} ${label.slice(0, 100)}`,
      tool: 'click',
      args: toArgs({ captureId, x: center.x, y: center.y }),
    });
    if (candidates.length >= 30) break;
  }
  return candidates;
}

/** Accept only capture-bound, exact-window, in-bounds visual regions. */
export function visualCandidates(payload: unknown, captureId: string, pid: number, windowId: number): Candidate[] {
  return collectCandidates(
    payload,
    captureId,
    source => source.kind === 'window' && source.pid === pid && source.window_id === windowId,
    ({ captureId: captured, x, y }) => ({ pid, window_id: windowId, x, y, capture_id: captured, delivery_mode: 'foreground' }),
    'Visual regions do not match the exact Cua capture and window',
  );
}

/**
 * Accept only capture-bound, exact-display, in-bounds visual regions of the
 * primary desktop. Used when a window surface cannot be resolved at all, so Jev
 * still decides from evidence instead of addressing arbitrary screen pixels.
 */
export function desktopVisualCandidates(payload: unknown, captureId: string, displayId: string): Candidate[] {
  if (!displayId) throw new Error('Visual regions do not match the exact Cua capture and desktop display');
  return collectCandidates(
    payload,
    captureId,
    source => source.kind === 'primary_desktop' && source.display_id === displayId,
    ({ captureId: captured, x, y }) => ({
      target: { kind: 'desktop', display_id: displayId },
      scope: 'desktop',
      x,
      y,
      capture_id: captured,
      delivery_mode: 'foreground',
    }),
    'Visual regions do not match the exact Cua capture and desktop display',
  );
}
