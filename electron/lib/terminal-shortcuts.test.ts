import { expect, it } from 'vitest';
import { isTerminalSystemShortcut } from './terminal-shortcuts.js';
it('preserves macOS quit, settings, window and fullscreen shortcuts in terminal focus', () => {
  for (const key of ['q', 'h', 'm', ',']) expect(isTerminalSystemShortcut({ key, meta: true, control: false }, 'darwin')).toBe(true);
  expect(isTerminalSystemShortcut({ key: 'f', meta: true, control: true }, 'darwin')).toBe(true);
});
it('does not intercept PTY control keys or terminal-local command shortcuts', () => {
  for (const key of ['c', 'r', 'a', 'b', 'j', 'q']) expect(isTerminalSystemShortcut({ key, meta: false, control: true }, 'darwin')).toBe(false);
  for (const key of ['k', 'f', 'w']) expect(isTerminalSystemShortcut({ key, meta: true, control: false }, 'darwin')).toBe(false);
  expect(isTerminalSystemShortcut({ key: 'a', meta: false, control: true }, 'win32')).toBe(false);
});
