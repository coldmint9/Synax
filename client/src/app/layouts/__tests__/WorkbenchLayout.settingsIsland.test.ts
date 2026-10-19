import postcss from 'postcss';
import { describe, expect, it } from 'vitest';
import css from '../../../index.css?raw';
import deckCss from '../../../shared/design/command-deck.css?raw';
import layoutSource from '../WorkbenchLayout.tsx?raw';
import headerSource from '../WorkbenchHeader.tsx?raw';
import gitWorkbenchCss from '../../../features/git/gitWorkbench.css?raw';

const stylesheet = postcss.parse(css + '\n' + deckCss);
function declaration(selector: string, property: string, root = stylesheet) {
  let value: string | undefined;
  root.walkRules(rule => {
    if (rule.parent?.type === 'atrule' && rule.parent.name === 'media') return;
    if (!rule.selectors.map(s => s.replace(/\s+/g, ' ').trim()).includes(selector)) return;
    rule.walkDecls(property, decl => { value = decl.value; });
  });
  return value;
}

describe('canonical command deck', () => {
  it('reserves a global row instead of positioning controls over page content', () => {
    expect(declaration('.workbench-header', 'position')).toBe('relative');
    expect(declaration('.workbench-header', 'flex')).toBe('0 0 auto');
    expect(declaration('.workbench-header', 'left')).toBeUndefined();
    expect(headerSource).not.toContain('<WorkbenchIsland');
  });
  it('leaves platform control clearance in the top row and keeps actions clickable', () => {
    expect(declaration('.electron-windows .workbench-header__bar', 'padding-right')).toBe('126px');
    expect(declaration('.electron-macos .workbench-header__bar', 'padding-left')).toContain('88px');
    expect(declaration('.workbench-header__bar', '-webkit-app-region')).toBe('drag');
    expect(declaration('.wh-btn', '-webkit-app-region')).toBe('no-drag');
  });
  it('keeps Git controls in the centered navigation row', () => {
    expect(declaration('.workbench-header__navigation', 'display')).toBe('flex');
    expect(declaration('.workbench-header__git-tools', 'overflow-x')).toBe('auto');
    expect(declaration('.workbench-header__git-tools .git-island-toolbar', 'width')).toBe('max-content');
    expect(headerSource).toContain('<GitToolbarTarget />');
  });
  it('renders a full borderless raised pill rather than a blurred underline', () => {
    expect(declaration('.island-selection-pill', 'top')).toBe('0');
    expect(declaration('.island-selection-pill', 'border-radius')).toBe('9999px');
    expect(declaration('.island-selection-pill', 'border')).toBe('0');
    expect(declaration('.island-selection-pill', 'background')).toContain('--island-pill-background');
    expect(declaration('.island-selection-pill', 'box-shadow')).toContain('--island-pill-shadow');
    expect(deckCss).not.toContain('.island-selection-shadow');
  });
  it('uses a single glass envelope rather than stacking blur and shadows on its host', () => {
    expect(declaration('.synax-island', 'background')).toBe('transparent');
    expect(declaration('.synax-island', 'box-shadow')).toBe('none');
    expect(declaration('.synax-island', 'backdrop-filter')).toBeUndefined();
    expect(headerSource).toContain('<header className="workbench-header"');
    expect(headerSource).not.toContain('<Dropdown');
  });
  it('paints one solid island material in both themes without changing other glass surfaces', () => {
    const material = '.synax-island-material.liquid-glass-surface[data-glass-state]';
    expect(declaration(material, '--glass-base')).toBe('var(--island-material-background)');
    expect(declaration(material, '--glass-transparent')).toBe('var(--island-material-background)');
    expect(declaration(material, '--glass-solid')).toBe('var(--island-material-background)');
    // The envelope must stay opaque: no backdrop blur re-enters through this rule.
    expect(declaration(material, '--glass-blur')).toBe('0px');
    expect(declaration(material + ' > .liquid-glass-backdrop', 'backdrop-filter')).toBe('none');
    expect(declaration('.synax-island', '--island-material-background')).toBe('var(--ui-panel-soft)');
    expect(declaration('.dark .synax-island', '--island-material-background')).toBe('var(--ui-panel-soft)');
    expect(declaration('.synax-island', '--island-pill-background')).toBe('var(--ui-panel)');
    expect(declaration('.dark .synax-island', '--island-pill-background')).toBeUndefined();
  });
  it('keeps the optical layers off and separates the envelope with a hairline and one soft shadow', () => {
    const material = '.synax-island-material.liquid-glass-surface[data-glass-state]';
    expect(declaration(material + ' > .liquid-glass-backdrop', 'box-shadow')).toBe(
      'inset 0 0 0 1px var(--island-material-border), var(--island-material-shadow)');
    expect(declaration(material + ' > :is(.liquid-glass-svg, .liquid-glass-gpu-host)', 'display')).toBe('none');
    expect(declaration('.synax-island', '--island-material-border')).toContain('--theme-border-strong');
    expect(declaration('.dark .synax-island', '--island-material-shadow')).not.toContain('inset');
    expect(declaration('.synax-island', '--island-pill-shadow')).not.toContain('inset');
    expect(declaration('.dark .synax-island', '--island-pill-shadow')).not.toContain('inset');
    expect(declaration('.synax-island', '--island-pill-background')).not.toContain('gradient');
    expect(declaration('.island-selection-pill', 'border')).toBe('0');
  });
  it('keeps unselected controls clear and uses foreground contrast with a local halo', () => {
    const controls = '.synax-island :is(.wh-tab, .wh-btn, .wh-project-trigger, .wh-goal-menu, .wh-pill-btn)';
    expect(declaration(controls, 'color')).toBe('var(--island-ink)');
    expect(declaration(controls, 'font-weight')).toBe('600');
    expect(declaration(controls, 'text-shadow')).toContain('--island-ink-halo');
    expect(declaration(controls + ':hover:not(:disabled)', 'background')).toBe('transparent');
    expect(declaration('.synax-island :is(button, [role="radio"], select):focus-visible', 'outline')).toBe('2px solid var(--island-ink)');
    expect(declaration('.synax-island', '--island-ink')).toBe('var(--theme-text)');
    expect(declaration('.dark .synax-island', '--island-ink')).toBe('var(--theme-text)');
    expect(declaration('.dark .synax-island', '--island-ink-halo')).toContain('var(--theme-shadow-rgb)');
  });
  it('represents collapsible navigation as toggle buttons, not fake tabs with no panel', () => {
    const nav = headerSource.split('function MainNavTabs(')[1].split('function GoalToolbar(')[0];
    expect(nav).toContain('aria-pressed={activePanel === tab.id}');
    expect(nav).not.toContain('Tabs.ListContainer');
    expect(nav).toContain('onClick={() => onPanelToggle(tab.id)}');
  });
  it('retains Git actions and removes the obsolete overlay gutter', () => {
    expect(layoutSource).toContain('<GitToolbarProvider>');
    expect(headerSource).toContain('gitToolbarVisible &&');
    expect(headerSource).toContain('<GitToolbarTarget />');
    expect(declaration('.git-workbench', 'padding', postcss.parse(gitWorkbenchCss))).toBe('24px 32px 28px');
  });
});
