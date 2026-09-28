import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { Menu, MenuButton, MenuAction } from '../../components/ui/Menu';
import { IslandMenuItems } from '../IslandOverlays';
import { loadMotion } from '../../design/motion';

const motion = vi.hoisted(() => ({ set: vi.fn(), to: vi.fn(), killTweensOf: vi.fn() }));
const preferences = vi.hoisted(() => ({ reduced: false }));
vi.mock('../../design/motion', () => ({ loadMotion: vi.fn(async () => motion), reducedMotion: () => preferences.reduced }));
beforeEach(() => { vi.clearAllMocks(); preferences.reduced = false; });
function Fixture() {
  return <Menu>{({ open }) => <>
    <MenuButton>Projects</MenuButton>
    <IslandMenuItems open={open} anchor={false} aria-label="Projects menu"><MenuAction>Synax</MenuAction></IslandMenuItems>
  </>}</Menu>;
}
describe('Island overlays', () => {
  it('keeps exit visuals inert, then removes them after GSAP finishes', async () => {
    render(<Fixture />);
    fireEvent.click(screen.getByRole('button', { name: 'Projects' }));
    await act(async () => {});
    const panel = screen.getByRole('menu');
    expect(motion.to).toHaveBeenCalledWith(panel, expect.objectContaining({ y: 0, opacity: 1 }));
    fireEvent.keyDown(panel, { key: 'Escape' });
    await act(async () => {});
    expect(panel).toHaveAttribute('inert');
    expect(panel).toHaveAttribute('aria-hidden', 'true');
    expect(screen.queryByRole('menu')).toBeNull();
    const exit = motion.to.mock.calls[motion.to.mock.calls.length - 1][1];
    expect(exit).toMatchObject({ y: -5, opacity: 0 });
    act(() => exit.onComplete());
    expect(panel.isConnected).toBe(false);
  });
  it('does not remove a menu reopened before its exit completes', async () => {
    render(<Fixture />);
    const trigger = screen.getByRole('button', { name: 'Projects' });
    fireEvent.click(trigger);
    await act(async () => {});
    fireEvent.keyDown(screen.getByRole('menu'), { key: 'Escape' });
    await act(async () => {});
    const exit = motion.to.mock.calls[motion.to.mock.calls.length - 1][1];
    fireEvent.click(trigger);
    await act(async () => {});
    act(() => exit.onComplete());
    expect(screen.getByRole('menu')).not.toHaveAttribute('inert');
  });
  it('removes immediately and skips GSAP for reduced motion', async () => {
    preferences.reduced = true;
    render(<Fixture />);
    fireEvent.click(screen.getByRole('button', { name: 'Projects' }));
    await act(async () => {});
    const panel = screen.getByRole('menu');
    fireEvent.keyDown(panel, { key: 'Escape' });
    await act(async () => {});
    expect(panel.isConnected).toBe(false);
    expect(motion.to).not.toHaveBeenCalled();
  });
  it('keeps menus visible and dismissible when the motion chunk fails', async () => {
    vi.mocked(loadMotion).mockRejectedValueOnce(new Error('Motion chunk unavailable'));
    render(<Fixture />);
    const trigger = screen.getByRole('button', { name: 'Projects' });
    fireEvent.click(trigger);
    await act(async () => {});
    const panel = screen.getByRole('menu');
    expect(panel.style.opacity).not.toBe('0');
    expect(panel).not.toHaveAttribute('inert');
    vi.mocked(loadMotion).mockRejectedValueOnce(new Error('Motion chunk unavailable'));
    fireEvent.keyDown(panel, { key: 'Escape' });
    await act(async () => {});
    expect(panel.isConnected).toBe(false);
    expect(trigger).toHaveFocus();
  });

  it('reveals an opening menu when reduced motion changes before GSAP loads', async () => {
    const engine = await loadMotion();
    let resolve!: () => void;
    const pending = new Promise<void>(done => { resolve = done; });
    vi.mocked(loadMotion).mockImplementationOnce(async () => { await pending; return engine; });
    const media = window.matchMedia('(prefers-reduced-motion: reduce)');
    const original = window.matchMedia;
    window.matchMedia = () => media;
    try {
      render(<Fixture />);
      fireEvent.click(screen.getByRole('button', { name: 'Projects' }));
      const panel = screen.getByRole('menu');
      expect(panel.style.opacity).toBe('0');
      preferences.reduced = true;
      await act(async () => {
        for (const [event, listener] of vi.mocked(media.addEventListener).mock.calls) {
          if (event !== 'change') continue;
          if (typeof listener === 'function') listener.call(media, new Event('change'));
          else listener.handleEvent(new Event('change'));
        }
        resolve();
      });
      expect(panel.style.opacity).not.toBe('0');
      expect(motion.to).not.toHaveBeenCalled();
      fireEvent.keyDown(panel, { key: 'Escape' });
      await act(async () => {});
      expect(panel.isConnected).toBe(false);
    } finally { window.matchMedia = original; resolve(); }
  });

});
