import { describe, expect, it } from 'vitest';
import { formatPrettyLogLine } from '../log-pretty.js';

describe('formatPrettyLogLine', () => {
  it('includes level label and message', () => {
    const line = formatPrettyLogLine({ level: 50, time: Date.now(), msg: 'boom' });
    expect(line).toContain('ERROR');
    expect(line).toContain('boom');
  });

  it('uses different styling for info and error', () => {
    const info = formatPrettyLogLine({ level: 30, time: Date.now(), msg: 'ok' });
    const error = formatPrettyLogLine({ level: 50, time: Date.now(), msg: 'fail' });
    expect(info).toContain('INFO');
    expect(error).toContain('ERROR');
    expect(info).not.toEqual(error);
  });

  it('appends context payload when present', () => {
    const line = formatPrettyLogLine({
      level: 30,
      time: Date.now(),
      msg: 'request',
      method: 'GET',
      path: '/api/health',
      status: 200,
    });
    expect(line).toContain('request');
    expect(line).toContain('/api/health');
  });
});
