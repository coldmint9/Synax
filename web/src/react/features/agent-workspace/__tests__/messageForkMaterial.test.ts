import postcss from 'postcss';
import { describe, expect, it } from 'vitest';
import css from '../messageActions.css?raw';

const root = postcss.parse(css);
const material = '.message-fork-material.liquid-glass-surface[data-glass-state]';
function value(selector: string, property: string) {
  let result: string | undefined;
  root.walkRules(rule => {
    if (rule.parent?.type === 'atrule') return;
    if (rule.selectors.includes(selector)) rule.walkDecls(property, decl => { result = decl.value; });
  });
  return result;
}
describe('fork pop material', () => {
  it('uses a translucent white blur surface with a soft non-inset shadow', () => {
    expect(value(material, '--glass-transparent')).toBe('rgb(255 255 255 / .78)');
    expect(value(material, '--glass-base')).toBe('rgb(255 255 255 / .94)');
    expect(value(material, '--glass-blur')).toBe('18px');
    expect(value(material, '--fork-shadow')).toContain('24px');
    expect(value(material, '--fork-shadow')).not.toContain('inset');
    expect(value(material + ' > .liquid-glass-backdrop', 'box-shadow')).toBe('var(--fork-shadow)');
  });
  it('uses translucent black in dark mode rather than a transparent or white surface', () => {
    const dark = material + '[data-glass-theme="dark"]';
    expect(value(dark, '--glass-transparent')).toBe('rgb(0 0 0 / .66)');
    expect(value(dark, '--glass-base')).toBe('rgb(0 0 0 / .94)');
    expect(value(dark, '--fork-shadow')).not.toContain('inset');
  });
  it('keeps the outer container borderless and avoids a second painted layer', () => {
    expect(value('.message-fork-pop.ui-menu-items', 'border')).toBe('0');
    expect(value('.message-fork-pop.ui-menu-items', 'background')).toBe('transparent');
    expect(value('.message-fork-pop.ui-menu-items', 'box-shadow')).toBe('none');
  });
});
