import postcss from 'postcss';
import { describe, expect, it } from 'vitest';
import css from '../../../index.css?raw';
import deckCss from '../../design/command-deck.css?raw';
import workPageCss from '../../features/agent-workspace/workPage.css?raw';
import layoutSource from '../WorkbenchLayout.tsx?raw';
import headerSource from '../WorkbenchHeader.tsx?raw';
import gitWorkbenchCss from '../../features/git/gitWorkbench.css?raw';

const stylesheet = postcss.parse(css + '\n' + deckCss);
const workPageStylesheet = postcss.parse(workPageCss);
const fullWidth = '.workbench-shell:is([data-active-panel="git"], [data-active-panel="settings"], [data-has-project="false"]) .workbench-header';
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
  it('centers Git, Settings and the empty workspace without a phantom sidebar', () => {
    expect(layoutSource).toContain('data-active-panel={activePanel ?? undefined}');
    expect(layoutSource).toContain('data-has-project={!!effectiveProjectId}');
    expect(declaration(fullWidth, '--island-center-offset')).toBe('0px');
  });
  it('shares a top inset with the conversation slot and keeps controls outside drag regions', () => {
    expect(declaration('.workbench-header', 'top')).toContain('var(--workbench-island-top');
    expect(declaration('.workspace-island-slot--conversation', 'top', workPageStylesheet)).toBe('var(--workbench-island-top)');
    expect(declaration('.wh-btn', '-webkit-app-region')).toBe('no-drag');
  });
  it('moves only the Wiki group another 40px left', () => {
    expect(parseFloat(declaration('.workbench-header', '--island-center-offset')!) - parseFloat(declaration('.workbench-shell[data-active-panel="wiki"] .workbench-header', '--island-center-offset')!)).toBe(40);
  });
  it('keeps contextual tools in flow while their measured width expands', () => {
    expect(declaration('.workbench-header', 'left')).toBe('calc(50% + var(--island-center-offset))');
    expect(declaration('.wh-pill-slot', 'width')).toBe('0');
    expect(declaration('.wh-pill-slot.open', 'width')).toBe('calc(var(--toolbar-width, 0px) + var(--toolbar-gap))');
    expect(declaration('.wh-pill-slot', '--toolbar-gap')).toBe('8px');
    expect(declaration('.wh-pill-slot', 'transition')).toBeUndefined();
    expect(declaration('.synax-island', 'flex')).toBe('0 0 auto');
  });
  it('uses capsule geometry and removes the pixel branding from the Island', () => {
    expect(declaration('.synax-island', 'border-radius')).toBe('9999px');
    expect(declaration('.workbench-header--docked .synax-island', 'border-radius')).toBe('9999px');
    expect(headerSource).not.toContain('PixelMark');
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
    expect(headerSource).toContain('<IslandSurface kind="primary">');
    expect(headerSource).not.toContain('<Dropdown');
  });
  it('keeps the island untinted in both themes without changing other glass surfaces', () => {
    const material = '.synax-island-material.liquid-glass-surface[data-glass-state]';
    expect(declaration(material, '--glass-base')).toBe('transparent');
    expect(declaration(material, '--glass-transparent')).toBe('transparent');
    expect(declaration('.synax-island', '--island-pill-background')).toBe('var(--ui-panel)');
    expect(declaration('.dark .synax-island', '--island-pill-background')).toBeUndefined();
  });
  it('removes optical outlines and uses a flat selected pill with only a soft shadow', () => {
    const material = '.synax-island-material.liquid-glass-surface[data-glass-state]';
    expect(declaration(material + ' > .liquid-glass-backdrop', 'box-shadow')).toBe('none');
    expect(declaration(material + ' > :is(.liquid-glass-svg, .liquid-glass-gpu-host)', 'display')).toBe('none');
    expect(declaration('.synax-island', '--island-pill-shadow')).not.toContain('inset');
    expect(declaration('.dark .synax-island', '--island-pill-shadow')).not.toContain('inset');
    expect(declaration('.synax-island', '--island-pill-background')).not.toContain('gradient');
    expect(declaration('.island-selection-pill', 'border')).toBe('0');
  });
  it('keeps unselected controls clear and uses foreground contrast with a local halo', () => {
    const controls = '.synax-island :is(.wh-tab, .wh-btn, .wh-project-trigger, .wh-goal-menu, .wh-pill-btn, .wiki-view-tab)';
    expect(declaration(controls, 'color')).toBe('var(--island-ink)');
    expect(declaration(controls, 'font-weight')).toBe('600');
    expect(declaration(controls, 'text-shadow')).toContain('--island-ink-halo');
    expect(declaration(controls + ':hover:not(:disabled)', 'background')).toBe('transparent');
    expect(declaration('.synax-island :is(button, [role="radio"], select):focus-visible', 'outline')).toBe('2px solid var(--island-ink)');
    expect(declaration('.synax-island', '--island-ink')).not.toBe(declaration('.dark .synax-island', '--island-ink'));
  });
  it('represents collapsible navigation as toggle buttons, not fake tabs with no panel', () => {
    const nav = headerSource.split('function MainNavTabs(')[1].split('function WikiToolbar(')[0];
    expect(nav).toContain('aria-pressed={activePanel === tab.id}');
    expect(nav).not.toContain('Tabs.ListContainer');
    expect(nav).toContain('onClick={() => onPanelToggle(tab.id)}');
  });
  it('retains the Git secondary island and document reading gutter', () => {
    expect(layoutSource).toContain('<GitToolbarProvider>');
    expect(headerSource).toContain('<ToolbarPill visible={gitToolbarVisible}>');
    expect(headerSource).toContain('<GitToolbarTarget />');
    expect(declaration('.git-workbench', 'padding', postcss.parse(gitWorkbenchCss))).toBe('56px 32px 28px');
  });
});
