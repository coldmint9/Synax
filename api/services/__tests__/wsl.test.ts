import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decodeWslOutput, listWslDistributions, parseWslListVerbose, wslCommandSpec, wslLauncherEnvironment } from '../wsl.js';

afterEach(() => { delete process.env.SYNAX_WSL_EXE });

describe('WSL gateway', () => {
  it('decodes UTF-16LE output emitted by wsl.exe', () => {
    const text = '  NAME      STATE    VERSION\r\n* Ubuntu    Running  2\r\n';
    expect(decodeWslOutput(Buffer.from(`\ufeff${text}`, 'utf16le'))).toContain('Ubuntu');
  });

  it('parses localized headers, default markers, spaces and filters WSL1', () => {
    const output = [
      '  名称                         状态            版本',
      '* Ubuntu 24.04                Running         2',
      '  Debian                      Stopped         2',
      '  Legacy Linux                Stopped         1',
    ].join('\r\n');
    expect(parseWslListVerbose(output)).toEqual([
      { name: 'Ubuntu 24.04', version: 2, default: true, state: 'Running' },
      { name: 'Debian', version: 2, default: false, state: 'Stopped' },
    ]);
  });


  it('can probe a fake wsl executable without depending on a Windows host', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-fake-wsl-'));
    const executable = path.join(dir, 'wsl');
    fs.writeFileSync(executable, '#!/bin/sh\nprintf "  NAME STATE VERSION\n* Ubuntu Running 2\n  Legacy Stopped 1\n"\n');
    fs.chmodSync(executable, 0o755);
    process.env.SYNAX_WSL_EXE = executable;
    await expect(listWslDistributions({ platform: 'win32' })).resolves.toEqual([
      { name: 'Ubuntu', state: 'Running', version: 2, default: true },
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
  });


  it('forwards only explicit non-Windows overrides through WSLENV', () => {
    const previous = process.env.WSLENV;
    process.env.WSLENV = 'HTTPS_PROXY';
    const env = wslLauncherEnvironment({
      ...process.env,
      PATH: 'C:\\custom',
      HOME: 'C:\\Users\\Mint',
      GIT_TERMINAL_PROMPT: '0',
    });
    expect(env.WSLENV?.split(':')).toEqual(expect.arrayContaining(['HTTPS_PROXY', 'GIT_TERMINAL_PROMPT']));
    expect(env.WSLENV).not.toMatch(/(?:^|:)PATH(?::|$)/);
    expect(env.WSLENV).not.toMatch(/(?:^|:)HOME(?::|$)/);
    if (previous === undefined) delete process.env.WSLENV; else process.env.WSLENV = previous;
  });

  it('builds a parameterized direct command without shell interpolation', () => {
    expect(wslCommandSpec('Ubuntu Dev', '/home/me/a b', 'git', ['status', '--short'])).toEqual({
      command: 'wsl.exe',
      args: ['--distribution', 'Ubuntu Dev', '--cd', '/home/me/a b', '--exec', 'git', 'status', '--short'],
    });
  });


  it('adds an owner marker and rejects injected distribution names', () => {
    expect(wslCommandSpec('Ubuntu', '/repo', 'npm', ['test'], { ownerId: 'owner-1' })).toEqual({
      command: 'wsl.exe',
      args: ['--distribution', 'Ubuntu', '--cd', '/repo', '--exec', '/usr/bin/env', 'SYNAX_PROCESS_OWNER=owner-1', '/usr/bin/setsid', 'npm', 'test'],
    });
    expect(() => wslCommandSpec('Ubuntu\n--exec', '/repo', 'git', [])).toThrow(/distribution name is invalid/i);
  });

  it('uses /bin/sh only for shell commands', () => {
    expect(wslCommandSpec('Ubuntu', '/repo', 'printf "$HOME"', [], { shell: true })).toEqual({
      command: 'wsl.exe',
      args: ['--distribution', 'Ubuntu', '--cd', '/repo', '--exec', '/bin/sh', '-c', 'printf "$HOME"'],
    });
  });
});
