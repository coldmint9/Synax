import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const source = readFileSync('src/react/design/tokens.css', 'utf8');
const themes = [source.match(/:root\s*\{([^}]+)\}/)?.[1], source.match(/\.dark\s*\{([^}]+)\}/)?.[1]];

function hex(theme: string, token: string): string {
  const value = theme.match(new RegExp(`--${token}:\\s*(#[0-9a-f]{6})\\s*;`, 'i'))?.[1];
  expect(value, `${token} must be a solid color`).toBeDefined();
  return value!;
}

function luminance(color: string): number {
  const channels = color.slice(1).match(/../g)!.map((channel) => {
    const value = parseInt(channel, 16) / 255;
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  });
  return channels[0] * 0.2126 + channels[1] * 0.7152 + channels[2] * 0.0722;
}

function contrast(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (lighter + 0.05) / (darker + 0.05);
}

describe('app color themes', () => {
  it('pairs cool light surfaces with the reference dark canvas and sidebar', () => {
    expect(hex(themes[0]!, 'ui-canvas')).toBe('#f7f8fa');
    expect(hex(themes[0]!, 'ui-panel')).toBe('#ffffff');
    expect(hex(themes[1]!, 'ui-canvas')).toBe('#10141c');
    expect(hex(themes[1]!, 'ui-panel')).toBe('#171b23');
  });

  it.each(themes)('keeps primary and secondary text legible on both surfaces', (theme) => {
    expect(theme).toBeDefined();
    for (const surface of ['ui-canvas', 'ui-panel']) {
      expect(contrast(hex(theme!, 'ui-text'), hex(theme!, surface))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(hex(theme!, 'ui-subtle'), hex(theme!, surface))).toBeGreaterThanOrEqual(4.5);
    }
  });
});
