import { expect, it } from 'vitest';
import { desktopVisualCandidates, visualCandidates } from './visual-regions.js';
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

const desktopFixture = {
  schema: 'cua.visual_regions_v1',
  capture: {
    capture_id: 'capture-desktop',
    source: { kind: 'primary_desktop', display_id: 'primary' },
    screenshot: { mime_type: 'image/png', reference: 'capture://desktop', width: 100, height: 80 },
    action_coordinate_space: { kind: 'affine', m11: 2, m12: 0, m21: 0, m22: 2, tx: 4, ty: 6 },
  },
  regions: [{ id: 'region-1', kind: 'text', text: 'Submit', bounds: { x: 10, y: 20, width: 30, height: 20 }, confidence: 0.9, interactive: true }],
};

it('creates exact capture-bound desktop clicks with the primary-desktop target', () => {
  expect(desktopVisualCandidates(desktopFixture, 'capture-desktop', 'primary')[0]).toMatchObject({
    tool: 'click',
    args: {
      target: { kind: 'desktop', display_id: 'primary' },
      scope: 'desktop',
      capture_id: 'capture-desktop',
      x: 4 + 25 * 2,
      y: 6 + 30 * 2,
      delivery_mode: 'foreground',
    },
  });
  expect(() => desktopVisualCandidates(desktopFixture, 'stale', 'primary')).toThrow();
  expect(() => desktopVisualCandidates(desktopFixture, 'capture-desktop', 'secondary')).toThrow();
  expect(() => desktopVisualCandidates(fixture, 'capture-1', 'primary')).toThrow();
});

it('applies the affine action-coordinate mapping to off-axis matrices', () => {
  const skewed = {
    ...desktopFixture,
    capture: {
      ...desktopFixture.capture,
      action_coordinate_space: { kind: 'affine', m11: 2, m12: 1, m21: -1, m22: 0.5, tx: 7, ty: -3 },
    },
  };
  const click = desktopVisualCandidates(skewed, 'capture-desktop', 'primary')[0].args as { x: number; y: number };
  expect(click.x).toBeCloseTo(7 + 2 * 25 + 1 * 30);
  expect(click.y).toBeCloseTo(-3 - 1 * 25 + 0.5 * 30);
});

it('keeps scaled_top_left support and refuses unknown coordinate spaces', () => {
  const scaled = {
    ...fixture,
    capture: {
      ...fixture.capture,
      action_coordinate_space: { kind: 'scaled_top_left', action_units_per_pixel_x: 2, action_units_per_pixel_y: 2, action_origin_x: 1, action_origin_y: 2 },
    },
  };
  expect(visualCandidates(scaled, 'capture-1', 42, 123)[0].args).toMatchObject({ x: 1 + 25 * 2, y: 2 + 30 * 2 });
  const unknown = { ...fixture, capture: { ...fixture.capture, action_coordinate_space: { kind: 'rotated_3d' } } };
  expect(() => visualCandidates(unknown, 'capture-1', 42, 123)).toThrow(/coordinate mapping is invalid/);
});
