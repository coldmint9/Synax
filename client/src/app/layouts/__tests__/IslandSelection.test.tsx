import { act, render } from '@testing-library/react';
import { Radio, RadioGroup } from '@headlessui/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IslandSelection } from '../IslandSelection';
import { loadMotion } from '../../../shared/design/motion';

const motion = vi.hoisted(() => ({ set: vi.fn(), to: vi.fn(), getProperty: vi.fn(() => 1), killTweensOf: vi.fn() }));
const preferences = vi.hoisted(() => ({ reduced: false }));
vi.mock('../../../shared/design/motion', () => ({ reducedMotion: () => preferences.reduced, loadMotion: vi.fn(async () => motion) }));
const observers = new Set<() => void>();
const layout = async () => { await act(async () => { for (const notify of observers) notify(); }); };
const options = (active: string) => <>
  <button data-island-option="work" aria-pressed={active === 'work'}>Work</button>
  <button data-island-option="wiki" aria-pressed={active === 'wiki'}>Wiki</button>
  <button data-island-option="git" aria-current={active === 'git' ? 'page' : undefined}>Git</button>
</>;

beforeEach(() => {
  preferences.reduced = false;
  observers.clear();
  vi.stubGlobal('ResizeObserver', class {
    constructor(private notify: () => void) { observers.add(notify); }
    observe() {}
    unobserve() {}
    disconnect() { observers.delete(this.notify); }
  });
  vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(80);
  vi.spyOn(HTMLElement.prototype, 'offsetHeight', 'get').mockReturnValue(32);
  vi.spyOn(HTMLElement.prototype, 'offsetTop', 'get').mockReturnValue(2);
  vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (this: HTMLElement) {
    return ['wiki', 'plan'].includes(this.dataset.islandOption ?? '') ? 90 : this.dataset.islandOption === 'git' ? 180 : 0;
  });
});
afterEach(() => { vi.restoreAllMocks(); vi.clearAllMocks(); vi.unstubAllGlobals(); });

describe('IslandSelection', () => {
  it('follows the explicit Wiki key even when the previous ARIA state is still in the DOM', async () => {
    const { container, rerender } = render(<IslandSelection activeKey="work">{options('work')}</IslandSelection>);
    await layout();
    const pill = container.querySelector('[data-island-indicator]');
    expect(pill).toHaveAttribute('aria-hidden', 'true');
    rerender(<IslandSelection activeKey="wiki">{options('work')}</IslandSelection>);
    await act(async () => {});
    expect(motion.to).toHaveBeenLastCalledWith(pill, expect.objectContaining({ x: 90, y: 2, opacity: 1 }));
  });

  it('supports real Wiki radios and changes selection without synchronous layout reads', async () => {
    const wiki = (key: string) => <RadioGroup value={key} onChange={() => {}} aria-label="Wiki">
      <IslandSelection activeKey={key}>
        <Radio as="button" value="document" data-island-option="document">文档</Radio>
        <Radio as="button" value="plan" data-island-option="plan">规划</Radio>
      </IslandSelection>
    </RadioGroup>;
    const { container, rerender } = render(wiki('document'));
    await layout();
    expect(motion.set).toHaveBeenCalledWith(container.querySelector('[data-island-indicator]'), expect.objectContaining({ width: 80, height: 32, opacity: 1 }));
    const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get');
    width.mockClear();
    rerender(wiki('plan'));
    await act(async () => {});
    expect(width).not.toHaveBeenCalled();
    expect(motion.to).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ x: 90, scaleX: 1, scaleY: 1 }));
    expect(motion.to.mock.calls[motion.to.mock.calls.length - 1][1]).not.toHaveProperty('width');
    expect(motion.to.mock.calls[motion.to.mock.calls.length - 1][1]).not.toHaveProperty('height');
  });

  it('does not restart animation for duplicate resize notifications', async () => {
    const { rerender } = render(<IslandSelection activeKey="work">{options('work')}</IslandSelection>);
    await layout();
    rerender(<IslandSelection activeKey="wiki">{options('wiki')}</IslandSelection>);
    await act(async () => {});
    const count = motion.to.mock.calls.length;
    await layout();
    await layout();
    expect(motion.to).toHaveBeenCalledTimes(count);
  });

  it('recovers after a hidden toolbar gets its first visible layout', async () => {
    const width = vi.spyOn(HTMLElement.prototype, 'offsetWidth', 'get').mockReturnValue(0);
    render(<IslandSelection activeKey="wiki">{options('wiki')}</IslandSelection>);
    await layout();
    width.mockReturnValue(80);
    await layout();
    expect(motion.set).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ x: 90, width: 80, opacity: 1 }));
  });

  it('hides when nothing is selected and kills its tween on unmount', async () => {
    const { container, rerender, unmount } = render(<IslandSelection activeKey="work">{options('work')}</IslandSelection>);
    await layout();
    const pill = container.querySelector('[data-island-indicator]');
    rerender(<IslandSelection activeKey={null}>{options('none')}</IslandSelection>);
    await act(async () => {});
    expect(motion.to).toHaveBeenLastCalledWith(pill, expect.objectContaining({ opacity: 0 }));
    unmount();
    expect(motion.killTweensOf).toHaveBeenCalledWith(pill);
  });

  it('positions immediately without loading GSAP for reduced motion', async () => {
    preferences.reduced = true;
    const { container } = render(<IslandSelection activeKey="wiki">{options('wiki')}</IslandSelection>);
    await layout();
    expect(container.querySelector('[data-island-indicator]')).toHaveStyle({ transform: 'translate(90px, 2px)', width: '80px', height: '32px', opacity: '1' });
    expect(motion.to).not.toHaveBeenCalled();
    expect(motion.set).not.toHaveBeenCalled();
  });
  it('keeps static selection in sync when the motion chunk cannot load', async () => {
    vi.mocked(loadMotion).mockRejectedValueOnce(new Error('Motion chunk unavailable'));
    const { container, rerender } = render(<IslandSelection activeKey="work">{options('work')}</IslandSelection>);
    await layout();
    const pill = container.querySelector('[data-island-indicator]');
    expect(pill).toHaveStyle({ opacity: '1', transform: 'translate(0px, 2px)' });
    rerender(<IslandSelection activeKey="wiki">{options('wiki')}</IslandSelection>);
    await act(async () => {});
    expect(pill).toHaveStyle({ opacity: '1', transform: 'translate(90px, 2px)' });
    expect(motion.to).not.toHaveBeenCalled();
  });

});
