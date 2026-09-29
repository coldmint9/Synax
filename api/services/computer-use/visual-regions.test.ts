import { expect, it } from 'vitest';
import { visualCandidates } from './visual-regions.js';
const fixture = {
  schema: 'cua.visual_regions_v1',
  capture: {
    capture_id: 'capture-1',
    source: { kind: 'window', pid: 42, window_id: 123 },
    screenshot: { mime_type: 'image/png', reference: 'capture://safe', width: 100, height: 80 },
    action_coordinate_space: { kind: 'screenshot_pixels' },
  },
  regions: [{ id: 'region-1', kind: 'text', text: 'Submit', bounds: { x: 10, y: 20, width: 30, height: 20 }, confidence: 0.9, interactive: true }],
};
it('creates exact capture-bound visual clicks only', () => {
  expect(visualCandidates(fixture, 'capture-1', 42, 123)[0]).toMatchObject({ tool: 'click', args: { capture_id: 'capture-1', x: 25, y: 30, delivery_mode: 'foreground' } });
  expect(() => visualCandidates(fixture, 'stale', 42, 123)).toThrow();
  expect(() => visualCandidates(fixture, 'capture-1', 99, 123)).toThrow();
  expect(() => visualCandidates({ ...fixture, regions: [{ ...fixture.regions[0], bounds: { x: 95, y: 20, width: 30, height: 20 } }] }, 'capture-1', 42, 123)).toThrow();
});
