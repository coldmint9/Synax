import { execFileSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { THEME_COLOR_KEYS } from '../../lib/theme/contract';

const designDirectory = dirname(new URL(import.meta.url).pathname);
const repositoryRoot = resolve(designDirectory, '../../../..');
const task5BoundaryCommit = '02ed537';
const committedHead = 'HEAD';

function git(args: string[]): string {
  return execFileSync('git', args, { cwd: repositoryRoot, encoding: 'utf8' });
}

function enumerateTask6CssFiles(): string[] {
  return git([
    'diff',
    '--name-only',
    '--diff-filter=ACMR',
    task5BoundaryCommit,
    committedHead,
    '--',
    '*.css',
  ])
    .split('\n')
    .map((filePath) => filePath.trim())
    .filter(Boolean);
}

function readCommittedFile(filePath: string): string {
  return git(['show', `${committedHead}:${filePath}`]);
}

const task6CssFiles = enumerateTask6CssFiles();
const source = readCommittedFile('web/src/react/design/tokens.css');
const lightTheme = source.match(/:root\s*\{([\s\S]*?)\n\}/)?.[1];
const darkTheme = source.match(/\.dark\s*\{([\s\S]*?)\n\}/)?.[1];
const compatibilityBridge = source.match(/:root,\s*\.dark\s*\{([\s\S]*?)\n\}/)?.[1];
const themes = [lightTheme, darkTheme];

const kebab = (value: string) => value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
const themeColorTokens = THEME_COLOR_KEYS.flatMap((key) => [
  `--theme-${kebab(key)}`,
  `--theme-${kebab(key)}-hsl`,
]);
const themeShapeTokens = [
  '--theme-radius-sm',
  '--theme-radius-md',
  '--theme-radius-lg',
  '--theme-control-height',
];
const themeEffectTokens = [
  '--theme-control-shadow',
  '--theme-inset-shadow',
  '--theme-floating-shadow',
  '--theme-surface-shadow',
];
const themeEffectAliases = [
  '--theme-shadow-control',
  '--theme-shadow-inset',
  '--theme-shadow-floating',
];
const themePigmentTokens = ['--theme-shadow-rgb', '--theme-highlight-rgb'];

// Audit only the committed Task 6 CSS snapshot. Reading the working tree here
// would let unrelated dirty agent-workspace styles affect this test.
const themeMigrationCssFiles = task6CssFiles;

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

const compatibilityAliases: Record<string, string> = {
  '--ui-canvas': '--theme-canvas',
  '--ui-panel': '--theme-surface',
  '--ui-panel-soft': '--theme-surface-secondary',
  '--ui-text': '--theme-text',
  '--ui-subtle': '--theme-text-muted',
  '--ui-line': '--theme-border',
  '--ui-line-strong': '--theme-border-strong',
  '--ui-signal': '--theme-accent',
  '--ui-canvas-hsl': '--theme-canvas-hsl',
  '--ui-panel-hsl': '--theme-surface-hsl',
  '--ui-panel-soft-hsl': '--theme-surface-secondary-hsl',
  '--ui-text-hsl': '--theme-text-hsl',
  '--ui-subtle-hsl': '--theme-text-muted-hsl',
  '--ui-line-hsl': '--theme-border-hsl',
  '--ui-line-strong-hsl': '--theme-border-strong-hsl',
  '--ui-signal-hsl': '--theme-accent-hsl',
  '--ui-accent': '--theme-accent',
  '--ui-accent-soft': '--theme-accent-soft',
  '--ui-shadow-control': '--theme-control-shadow',
  '--ui-shadow-inset': '--theme-inset-shadow',
  '--ui-shadow-floating': '--theme-floating-shadow',
  '--ui-tooltip-background': '--theme-tooltip',
  '--ui-tooltip-foreground': '--theme-tooltip-foreground',
  '--background-hsl': '--theme-canvas-hsl',
  '--foreground-hsl': '--theme-text-hsl',
  '--border-hsl': '--theme-border-hsl',
  '--muted-hsl': '--theme-surface-secondary-hsl',
  '--background': '--theme-canvas',
  '--foreground': '--theme-text',
  '--border': '--theme-border',
  '--surface': '--theme-surface',
  '--surface-foreground': '--theme-text',
  '--surface-secondary': '--theme-surface-secondary',
  '--surface-shadow': '--theme-surface-shadow',
  '--overlay': '--theme-surface',
  '--overlay-foreground': '--theme-text',
  '--default': '--theme-surface-secondary',
  '--default-hover': '--theme-border',
  '--default-foreground': '--theme-text',
  '--muted': '--theme-text-muted',
  '--muted-foreground': '--theme-text-muted-hsl',
  '--card': '--theme-surface-hsl',
  '--card-foreground': '--theme-text-hsl',
  '--popover': '--theme-surface-hsl',
  '--popover-foreground': '--theme-text-hsl',
  '--secondary': '--theme-surface-secondary-hsl',
  '--secondary-foreground': '--theme-text-hsl',
  '--input': '--theme-input-hsl',
  '--field-background': '--theme-input',
  '--field-foreground': '--theme-input-foreground',
  '--field-placeholder': '--theme-text-muted',
  '--field-border': '--theme-border',
  '--field-border-hover': '--theme-border-strong',
  '--field-hover': '--theme-surface-secondary',
  '--field-focus': '--theme-surface',
  '--separator': '--theme-border',
  '--segment': '--theme-surface',
  '--segment-foreground': '--theme-text',
  '--scrollbar': '--theme-border-strong',
  '--agent-glass-bg': '--theme-surface',
  '--agent-glass-border': '--theme-border',
  '--agent-glass-shadow': '--theme-shadow-control',
  '--accent-hsl': '--theme-accent-hsl',
  '--accent-foreground-hsl': '--theme-accent-foreground-hsl',
  '--accent': '--theme-accent',
  '--accent-foreground': '--theme-accent-foreground',
  '--primary': '--theme-accent-hsl',
  '--primary-foreground': '--theme-accent-foreground-hsl',
  '--secondary-foreground': '--theme-text-hsl',
  '--success': '--theme-success',
  '--success-foreground': '--theme-tooltip-foreground',
  '--success-hsl': '--theme-success-hsl',
  '--warning': '--theme-warning',
  '--warning-foreground': '--theme-tooltip-foreground',
  '--warning-hsl': '--theme-warning-hsl',
  '--danger': '--theme-danger',
  '--danger-foreground': '--theme-tooltip-foreground',
  '--danger-hsl': '--theme-danger-hsl',
  '--info': '--theme-info',
  '--info-foreground': '--theme-tooltip-foreground',
  '--info-hsl': '--theme-info-hsl',
  '--destructive': '--theme-danger-hsl',
  '--destructive-foreground': '--theme-tooltip-foreground-hsl',
  '--ring': '--theme-focus-hsl',
  '--focus': '--theme-focus',
  '--field-border-focus': '--theme-focus',
  '--radius': '--theme-radius-compat',
  '--radius-lg': '--theme-radius-lg',
  '--radius-md': '--theme-radius-md',
  '--radius-sm': '--theme-radius-sm',
};

// These are the only direct appearance literals permitted outside tokens.css.
// Each entry is tied to an exact source line so a new literal cannot hide in a
// preview rule merely because it is in the same stylesheet.
const fixedAppearancePreviewLiterals: Record<number, readonly string[]> = {
  88: ['#00000010'],
  89: ['#fafafa'],
  97: ['#eeeeee'],
  98: ['#00000008'],
  104: ['#d1d1d1'],
  138: ['#0f141d'],
  141: ['#171b22'],
  144: ['#8c8c89'],
  147: ['#fafafa', '#0f141d'],
  181: ['#181818'],
};

// HSV/color-picker ramps are deliberately fixed visual geometry, not theme
// surfaces. Keep this allowlist limited to the rainbow stops themselves.
const hsvColorPickerLiterals: Record<number, readonly string[]> = {
  289: ['#000'],
  290: ['#fff'],
  337: ['#f00', '#ff0', '#0f0', '#0ff', '#00f', '#f0f', '#f00'],
};

// The opaque agent-dock action face predates Task 6 and is intentionally fixed.
// Keep this baseline exception exact so new hard-coded surfaces remain rejected.
const fixedIndexActionLiterals: Record<number, readonly string[]> = {
  3410: ['#101113'],
  3411: ['#fff'],
  3418: ['#25272c'],
  3421: ['#e2e5e9'],
  3422: ['#6f7783'],
  3425: ['#393e47'],
  3426: ['#abb1bb'],
};

function readThemeMigrationCss(): string {
  return themeMigrationCssFiles.map(readCommittedFile).join('\n');
}

function extractBlock(css: string, selector: string): string {
  const selectorStart = css.indexOf(selector);
  expect(selectorStart, `${selector} must exist`).toBeGreaterThanOrEqual(0);
  const openBrace = css.indexOf('{', selectorStart);
  let depth = 0;
  for (let index = openBrace; index < css.length; index += 1) {
    if (css[index] === '{') depth += 1;
    if (css[index] === '}') depth -= 1;
    if (depth === 0) return css.slice(openBrace + 1, index);
  }
  throw new Error(`${selector} has no closing brace`);
}

function declarations(block: string): Map<string, string> {
  return new Map(
    [...block.matchAll(/^\s*(--[\w-]+)\s*:\s*([^;]+);/gm)].map((match) => [match[1], match[2].trim()]),
  );
}

function findForbiddenThemeSurfaceLiterals(css: string, filePath: string): string[] {
  const findings: string[] = [];
  const allowedLiteralLines = filePath.endsWith('/appearance.css')
    ? { ...fixedAppearancePreviewLiterals, ...hsvColorPickerLiterals }
    : filePath.endsWith('/index.css')
      ? fixedIndexActionLiterals
      : {};
  const allowedLiterals = new Map(
    Object.entries(allowedLiteralLines).map(([line, literals]) => [Number(line), new Set(literals)]),
  );

  css.split('\n').forEach((line, index) => {
    const lineNumber = index + 1;
    const isSurfaceDeclaration = /^\s*(?:background(?:-color)?|color|border(?:-(?:top|right|bottom|left)-color)?|outline(?:-color)?)\s*:/.test(
      line,
    );
    const malformedColorFunction = /(?:hsl|rgb)a?\(\s*#/i.test(line);
    if (!isSurfaceDeclaration && !malformedColorFunction) return;

    for (const match of line.matchAll(/#[0-9a-f]{3,8}\b/gi)) {
      if (!allowedLiterals.get(lineNumber)?.has(match[0].toLowerCase())) {
        findings.push(`${filePath}:${lineNumber}:${match[0]}`);
      }
    }
  });

  return findings;
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
  it('declares the complete semantic theme token matrix in both modes', () => {
    const lightDeclarations = declarations(lightTheme!);
    const darkDeclarations = declarations(darkTheme!);

    for (const token of [...themeColorTokens, ...themeEffectTokens, ...themeEffectAliases]) {
      expect(lightDeclarations.has(token), `${token} must be declared in :root`).toBe(true);
      expect(darkDeclarations.has(token), `${token} must be declared in .dark`).toBe(true);
    }
    for (const token of themeShapeTokens) {
      expect(lightDeclarations.has(token), `${token} must be declared in :root`).toBe(true);
    }
    for (const token of themePigmentTokens) {
      expect(lightDeclarations.has(token), `${token} must be declared in :root`).toBe(true);
    }
  });

  it('declares the complete compatibility bridge through --theme-* variables', () => {
    const bridge = declarations(compatibilityBridge!);
    const expectedAliases = new Set(Object.keys(compatibilityAliases));
    const actualAliases = new Set(
      [...bridge.keys()].filter((token) => token.startsWith('--') && !token.startsWith('--theme-')),
    );

    expect(actualAliases).toEqual(expectedAliases);
    for (const [alias, themeToken] of Object.entries(compatibilityAliases)) {
      expect(bridge.get(alias), `${alias} must map through ${themeToken}`).toBe(`var(${themeToken})`);
    }
    expect(bridge.get('--theme-radius-compat')).toBe('10px');
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

  it('does not reintroduce retired palette or hard-coded theme surfaces in migration CSS', () => {
    const migrationCss = readThemeMigrationCss().toLowerCase();
    for (const literal of oldThemeLiterals) {
      expect(migrationCss, `${literal} must be replaced by a semantic theme token`).not.toContain(literal);
    }

    expect(migrationCss).not.toMatch(/var\(--[\w-]+\s*,\s*#[0-9a-f]{3,8}\b/i);

    const findings = themeMigrationCssFiles.flatMap((filePath) =>
      findForbiddenThemeSurfaceLiterals(readCommittedFile(filePath), filePath),
    );
    expect(findings, 'hard-coded theme surfaces must use --theme-* variables').toEqual([]);
  });

  it.each([
    ['index.css', resolve(designDirectory, '../index.css'), 'input { background: hsl(#2b2b2b / 0.7); }'],
    [
      'targeted component CSS',
      resolve(designDirectory, '../components/modalViewport.css'),
      '.synthetic-theme-surface {\n  background: #123456;\n}',
    ],
  ])('rejects a synthetic hard-coded theme surface in %s', (_label, filePath, css) => {
    expect(findForbiddenThemeSurfaceLiterals(css, filePath as string)).toHaveLength(1);
  });
});
