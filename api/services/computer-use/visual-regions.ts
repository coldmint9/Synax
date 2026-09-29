import type { Candidate } from './jev-decision.js';

function object(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function finitePositive(value: unknown): value is number { return typeof value === 'number' && Number.isFinite(value) && value > 0; }
/** Accept only capture-bound, exact-window, in-bounds visual regions. */
export function visualCandidates(payload: unknown, captureId: string, pid: number, windowId: number): Candidate[] {
  const root = object(payload), capture = object(root?.capture), source = object(capture?.source);
  const screenshot = object(capture?.screenshot), coordinates = object(capture?.action_coordinate_space);
  if (root?.schema !== 'cua.visual_regions_v1' || capture?.capture_id !== captureId ||
      source?.kind !== 'window' || source.pid !== pid || source.window_id !== windowId ||
      screenshot?.mime_type !== 'image/png' || typeof screenshot.reference !== 'string' || !screenshot.reference ||
      !finitePositive(screenshot.width) || !finitePositive(screenshot.height) ||
      !['screenshot_pixels', 'scaled_top_left'].includes(String(coordinates?.kind)) || !Array.isArray(root.regions))
    throw new Error('Visual regions do not match the exact Cua capture and window');
  if (coordinates?.kind === 'scaled_top_left' &&
      (!finitePositive(coordinates.action_units_per_pixel_x) || !finitePositive(coordinates.action_units_per_pixel_y) ||
       typeof coordinates.action_origin_x !== 'number' || !Number.isFinite(coordinates.action_origin_x) ||
       typeof coordinates.action_origin_y !== 'number' || !Number.isFinite(coordinates.action_origin_y)))
    throw new Error('Visual region coordinate mapping is invalid');
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
        (bounds.x as number) + bounds.width > (screenshot.width as number) ||
        (bounds.y as number) + bounds.height > (screenshot.height as number) ||
        typeof region?.confidence !== 'number' || !Number.isFinite(region.confidence) ||
        region.confidence < 0 || region.confidence > 1 || typeof region.interactive !== 'boolean')
      throw new Error('Visual region result is malformed, ambiguous, or out of bounds');
    seenIds.add(id);
    if (!region.interactive || region.confidence < 0.8 || labels.has(label.toLowerCase())) continue;
    labels.add(label.toLowerCase());
    candidates.push({
      id: `visual_${candidates.length}`,
      description: `Click the unique visual ${region.kind} ${label.slice(0, 100)}`,
      tool: 'click',
      args: { pid, window_id: windowId, x: (bounds.x as number) + bounds.width / 2,
        y: (bounds.y as number) + bounds.height / 2, capture_id: captureId, delivery_mode: 'foreground' },
    });
    if (candidates.length >= 30) break;
  }
  return candidates;
}
