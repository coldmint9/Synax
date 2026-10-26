import { act, cleanup, render } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { StreamingTextBlock } from '../StreamingTextBlock';
import { receiveFirstToken } from '../../../adapters/transport/firstTokenTiming';
afterEach(() => { cleanup(); vi.useRealTimers(); });
it.each([false, true])('reports the first committed paint for markdown=%s without delaying text', async markdown => {
  vi.useFakeTimers({ toFake: ['performance', 'requestAnimationFrame', 'cancelAnimationFrame'] });
  const stepId = `paint-${markdown}`;
  const paint = vi.fn();
  window.addEventListener('synax:first-token-painted', paint);
  try {
    receiveFirstToken({ sessionId: 's', runId: 'r', stepId, clientReceivedAt: Date.now() });
    const view = render(<StreamingTextBlock text="first visible token" isStreaming markdown={markdown} stepId={stepId} />);
    expect(view.container.textContent).toContain('first visible token');
    await act(async () => {});
    act(() => vi.advanceTimersByTime(48));
    expect(paint).toHaveBeenCalledOnce();
    expect(paint.mock.calls[0][0].detail).toMatchObject({ stepId, clientPaintAt: expect.any(Number) });
    view.rerender(<StreamingTextBlock text="first visible token and more" isStreaming markdown={markdown} stepId={stepId} />);
    act(() => vi.advanceTimersByTime(200));
    expect(paint).toHaveBeenCalledOnce();
  } finally { window.removeEventListener('synax:first-token-painted', paint); }
});
