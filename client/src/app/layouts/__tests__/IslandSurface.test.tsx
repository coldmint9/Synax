import { act, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IslandSurface } from '../IslandSurface';
const motion = vi.hoisted(() => ({ fromTo: vi.fn(), killTweensOf: vi.fn() }));
const preferences = vi.hoisted(() => ({ reduced: false }));
vi.mock('../../../shared/design/motion', () => ({ loadMotion: async () => motion, reducedMotion: () => preferences.reduced }));
beforeEach(() => { vi.clearAllMocks(); preferences.reduced = false; });
afterEach(() => vi.restoreAllMocks());

describe('Island click feedback', () => {
  it('animates the clicked control, preserves its action and cancels motion on unmount', async () => {
    const action = vi.fn();
    const { unmount } = render(<IslandSurface><button onClick={action}><span>Refresh</span></button></IslandSurface>);
    fireEvent.click(screen.getByText('Refresh'));
    await act(async () => {});
    const button = screen.getByRole('button');
    expect(action).toHaveBeenCalledOnce();
    expect(motion.fromTo).toHaveBeenCalledWith(button, { y: 1.5, scale: .96 }, expect.objectContaining({ y: 0, scale: 1, overwrite: true }));
    unmount();
    expect(motion.killTweensOf).toHaveBeenCalledWith(button);
  });
  it('does not animate disabled buttons', async () => {
    render(<IslandSurface><button disabled>Refresh</button></IslandSurface>);
    fireEvent.click(screen.getByRole('button'));
    await act(async () => {});
    expect(motion.fromTo).not.toHaveBeenCalled();
  });
  it('keeps actions but skips feedback for reduced motion', async () => {
    preferences.reduced = true;
    const action = vi.fn();
    render(<IslandSurface><button onClick={action}>Refresh</button></IslandSurface>);
    fireEvent.click(screen.getByRole('button'));
    await act(async () => {});
    expect(action).toHaveBeenCalledOnce();
    expect(motion.fromTo).not.toHaveBeenCalled();
  });
});
