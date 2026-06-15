import { afterEach, describe, expect, it, vi } from 'vitest';
import { reportScanProgress, deliverScanProgress, setScanProgressListener } from '../scan-progress.js';
import { logger } from '../../../lib/logger.js';

describe('reportScanProgress', () => {
  afterEach(() => {
    setScanProgressListener(null);
  });

  it('invokes progress listener on the main thread', () => {
    const listener = vi.fn();
    setScanProgressListener(listener);

    reportScanProgress({ message: '██░░░░░░░░ 20% — parsed 40/200 files', pct: 20, completed: 40, total: 200 });

    expect(listener).toHaveBeenCalledWith({
      message: '██░░░░░░░░ 20% — parsed 40/200 files',
      pct: 20,
      completed: 40,
      total: 200,
    });
  });

  it('logs progress when no listener is registered', () => {
    const infoSpy = vi.spyOn(logger, 'info');

    reportScanProgress({ message: '████████░░ 80% — detecting communities...', pct: 80 });

    expect(infoSpy).toHaveBeenCalledWith(
      '[analyzer] ████████░░ 80% — detecting communities...',
      { pct: 80, completed: undefined, total: undefined, projectId: undefined },
    );

    infoSpy.mockRestore();
  });

  it('deliverScanProgress invokes listener on the host thread', () => {
    const listener = vi.fn();
    setScanProgressListener(listener);

    deliverScanProgress({
      message: '██░░░░░░░░ 20% — parsed 40/200 files',
      pct: 20,
      completed: 40,
      total: 200,
      projectId: 'proj-1',
    });

    expect(listener).toHaveBeenCalledWith({
      message: '██░░░░░░░░ 20% — parsed 40/200 files',
      pct: 20,
      completed: 40,
      total: 200,
      projectId: 'proj-1',
    });
  });
});
