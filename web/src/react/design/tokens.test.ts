import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { THEME_COLOR_KEYS } from '../../lib/theme/contract';

const designDirectory = dirname(new URL(import.meta.url).pathname);
const source = readFileSync(resolve(designDirectory, 'tokens.css'), 'utf8');
const lightTheme = source.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1];
const darkTheme = source.match(/\.dark\s*\{([\s\S]*?)\n\}/)?.[1];
const themes = [lightTheme, darkTheme];

const kebab = (value: string) => value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
const requiredThemeTokens = [
  ...THEME_COLOR_KEYS.flatMap((key) => [`--theme-${kebab(key)}`, `--theme-${kebab(key)}-hsl`]),
  '--theme-radius-compat',
  '--theme-radius-sm',
  '--theme-radius-md',
  '--theme-radius-lg',
  '--theme-control-height',
  '--theme-control-shadow',
  '--theme-inset-shadow',
  '--theme-floating-shadow',
  '--theme-shadow-control',
  '--theme-shadow-inset',
  '--theme-shadow-floating',
  '--theme-surface-shadow',
  '--theme-shadow-rgb',
  '--theme-highlight-rgb',
];

const targetedCssFiles = [
  '../components/file-viewer/fileViewer.css',
  '../components/modalViewport.css',
  '../components/ui/GlassButton.css',
  '../components/ui/Tooltip.css',
  '../components/ui/glass/glass.css',
  '../design/command-deck.css',
  '../features/git/gitWorkbench.css',
  '../features/settings/components/appearance.css',
  '../features/terminal/terminal.css',
];

const oldThemeLiterals = [
  '#7b8090',
  '#d9dce3',
  '#5885eb',
  '#3569d4',
  '#cc6531',
  '#e8823d',
  '#25976b',
  '#d34f50',
  '#cb4448',
  '#d68b37',
  '#b34437',
  '#72d4c5',
  '#91a7ff',
  '#e9a76e',
  '#fafbfc',
  '#141618',
  '#f9fafb',
  '#fafbf7',
  '#1e221f',
  '#18221c',
  '#f4f8f3',
  '#d22f42',
];

function readTargetedCss(): string {
  return targetedCssFiles
    .map((relativePath) => readFileSync(resolve(designDirectory, relativePath), 'utf8'))
    .join('\n');
}

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
  it('declares every public theme token and keeps compatibility aliases downstream', () => {
    for (const token of requiredThemeTokens) {
      expect(source, `${token} must be declared in tokens.css`).toMatch(
        new RegExp(`${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*:`),
      );
    }

    expect(source).toMatch(/--background:\s*var\(--theme-canvas\)/);
    expect(source).toMatch(/--foreground:\s*var\(--theme-text\)/);
    expect(source).toMatch(/--primary:\s*var\(--theme-accent-hsl\)/);
    expect(source).toMatch(/--ui-shadow-floating:\s*var\(--theme-floating-shadow\)/);
  });

  it('pairs cool light surfaces with the reference dark canvas and sidebar', () => {
    expect(hex(lightTheme!, 'theme-canvas')).toBe('#f7f8fa');
    expect(hex(lightTheme!, 'theme-surface')).toBe('#ffffff');
    expect(hex(darkTheme!, 'theme-canvas')).toBe('#10141c');
    expect(hex(darkTheme!, 'theme-surface')).toBe('#171b23');
  });

  it.each(themes)('keeps primary and secondary text legible on both surfaces', (theme) => {
    expect(theme).toBeDefined();
    for (const surface of ['theme-canvas', 'theme-surface']) {
      expect(contrast(hex(theme!, 'theme-text'), hex(theme!, surface))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(hex(theme!, 'theme-text-muted'), hex(theme!, surface))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('does not reintroduce the retired palette in targeted component CSS', () => {
    const targetedCss = readTargetedCss().toLowerCase();

    for (const literal of oldThemeLiterals) {
      expect(targetedCss, `${literal} must be replaced by a semantic theme token`).not.toContain(literal);
    }

    expect(targetedCss).not.toMatch(/var\(--[\w-]+\s*,\s*#[0-9a-f]{3,8}\b/i);
  });
});
