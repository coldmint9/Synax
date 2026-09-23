import { describe, expect, it } from 'vitest';
import { fileClipboardCommands } from './file-clipboard.js';
import { systemTerminalCommand } from '../../api/services/file-openers/index.js';

describe('host file actions', () => {
  const file = '/repo/space & quote".txt';
  it('uses a Finder file reference, not path text, on macOS', () => {
    const [command] = fileClipboardCommands(file, 'darwin');
    expect(command.bin).toBe('/usr/bin/osascript');
    expect(command.args.at(-1)).toBe(file);
    expect(command.args.join(' ')).toContain('POSIX file');
  });
  it('uses a Windows FileDropList and URI file list on Linux', () => {
    const [windows] = fileClipboardCommands('C:\\repo\\a.txt', 'win32');
    expect(windows.args.join(' ')).toContain('SetFileDropList');
    expect(windows.env?.SYNAX_FILE_TO_COPY).toBe('C:\\repo\\a.txt');
    const linux = fileClipboardCommands(file, 'linux');
    expect(linux[0].input).toContain('file:///repo/space%20&%20quote%22.txt');
    expect(linux[0].args).toContain('text/uri-list');
  });
  it('launches system terminal in the parent directory without a shell command string', () => {
    const directory = '/repo/space & quote"';
    expect(systemTerminalCommand(directory, 'darwin')).toEqual({ bin: '/usr/bin/open', args: ['-a', 'Terminal', directory], cwd: directory });
    expect(systemTerminalCommand(directory, 'win32')).toEqual({ bin: 'cmd.exe', args: ['/K'], cwd: directory });
    expect(systemTerminalCommand(directory, 'linux')).toEqual({ bin: 'x-terminal-emulator', args: [], cwd: directory });
  });
});
