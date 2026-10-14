import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useActivityFrame } from './useActivityFrame';
import { useApiConnectivityStore } from '../lib/apiConnectivity';

function Icon({ id }: { id: string }) { const frame = useActivityFrame(); return <span data-testid={id}>{frame}</span>; }
beforeEach(() => {
  vi.useFakeTimers();
  Object.defineProperty(document, 'hidden', { configurable: true, value: false });
  useApiConnectivityStore.setState({ browserOnline: true, apiReachable: 'reachable' });
});
afterEach(() => { cleanup(); vi.useRealTimers(); Reflect.deleteProperty(document, 'hidden'); useApiConnectivityStore.setState({ browserOnline: true, apiReachable: 'unknown' }); });
describe('shared activity clock', () => {
  it('uses one low-frequency timer for many indicators and releases it on unmount', () => {
    const view = render(<>{Array.from({ length: 30 }, (_, i) => <Icon key={i} id={String(i)} />)}</>);
    expect(vi.getTimerCount()).toBe(1);
    const initial = screen.getByTestId('0').textContent;
    act(() => vi.advanceTimersByTime(499)); expect(screen.getByTestId('0').textContent).toBe(initial);
    act(() => vi.advanceTimersByTime(1)); expect(screen.getByTestId('0').textContent).not.toBe(initial);
    expect(new Set(screen.getAllByTestId(/\d/).map(el => el.textContent)).size).toBe(1);
    view.unmount(); expect(vi.getTimerCount()).toBe(0);
  });
  it('stops entirely while disconnected or hidden and resumes once', () => {
    render(<Icon id="clock" />);
    act(() => useApiConnectivityStore.setState({ apiReachable: 'unreachable' }));
    expect(vi.getTimerCount()).toBe(0);
    const frozen = screen.getByTestId('clock').textContent;
    act(() => vi.advanceTimersByTime(10_000)); expect(screen.getByTestId('clock').textContent).toBe(frozen);
    act(() => useApiConnectivityStore.setState({ apiReachable: 'reachable' })); expect(vi.getTimerCount()).toBe(1);
    act(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: true }); document.dispatchEvent(new Event('visibilitychange')); });
    expect(vi.getTimerCount()).toBe(0);
    act(() => { Object.defineProperty(document, 'hidden', { configurable: true, value: false }); document.dispatchEvent(new Event('visibilitychange')); });
    expect(vi.getTimerCount()).toBe(1);
  });
});
