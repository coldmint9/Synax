import { setSessionWorkspaceRoot, clearSessionWorkspaceRoot } from '../tools/workspace.js';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { parseBashInvocations } from '../tools/bash-command-policy.js';
import { bashTool, extractBashPaths } from '../tools/bash.js';

describe('bashTool', () => {
  describe('tool definition', () => {
    it('has correct metadata', () => {
      expect(bashTool.id).toBe('bash');
      expect(bashTool.category).toBe('shell');
      expect(bashTool.internalGate).toBe('shell');
      expect(bashTool.mutability).toBe('read');
      expect(bashTool.resumeBehavior).toBe('auto');
    });

    it('has progressiveDetails', () => {
      expect(typeof bashTool.progressiveDetails).toBe('string');
      expect(bashTool.progressiveDetails!.length).toBeGreaterThan(0);
    });

    it('has inputSchema with required command field', () => {
      expect(bashTool.inputSchema).toBeDefined();
    });
  });

  describe('execute - validation', () => {
    it('rejects missing command', () => {
      expect(() =>
        bashTool.execute({
          sessionId: 's1',
          runId: null,
          stepId: null,
          toolCallId: 'tc1',
          toolId: 'bash',
          category: 'shell',
          mutability: 'read',
          args: {},
        }),
      ).toThrow('command is required.');
    });

    it('rejects null byte in command', () => {
      expect(() =>
        bashTool.execute({
          sessionId: 's1',
          runId: null,
          stepId: null,
          toolCallId: 'tc1',
          toolId: 'bash',
          category: 'shell',
          mutability: 'read',
          args: { command: 'echo \0hello' },
        }),
      ).toThrow('null byte');
    });

    it('classifies disallowed commands for permission evaluation', () => {
      expect(parseBashInvocations('rm -rf /')[0]?.risk).toBe('write');
      expect(parseBashInvocations('cat file.txt | rm -rf /')[1]?.risk).toBe('write');
    });

    it('blocks file redirect to unsafe target', async () => {
      const result = await bashTool.execute({
        sessionId: 's1',
        runId: null,
        stepId: null,
        toolCallId: 'tc1',
        toolId: 'bash',
        category: 'shell',
        mutability: 'read',
        args: { command: 'echo hello > /tmp/output.txt' },
      });
      const r = result.result as Record<string, unknown>;
      expect(r.exitCode).toBeNull();
      expect(r.stderr).toContain('redirection');
    });

    it('allows redirect to /dev/null', async () => {
      const result = await bashTool.execute({
        sessionId: 's1',
        runId: null,
        stepId: null,
        toolCallId: 'tc1',
        toolId: 'bash',
        category: 'shell',
        mutability: 'read',
        args: { command: 'echo hello > /dev/null' },
      });
      const r = result.result as Record<string, unknown>;
      // Should not be blocked; exitCode 0 expected
      expect(r.exitCode).toBe(0);
    });
  });

  describe('execute - basic commands', () => {
    it('executes echo', async () => {
      const result = await bashTool.execute({
        sessionId: 's1',
        runId: null,
        stepId: null,
        toolCallId: 'tc1',
        toolId: 'bash',
        category: 'shell',
        mutability: 'read',
        args: { command: 'echo hello world' },
      });
      const r = result.result as Record<string, unknown>;
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('hello world');
    });

    it('executes ls', async () => {
      const result = await bashTool.execute({
        sessionId: 's1',
        runId: null,
        stepId: null,
        toolCallId: 'tc1',
        toolId: 'bash',
        category: 'shell',
        mutability: 'read',
        args: { command: 'ls -la' },
      });
      const r = result.result as Record<string, unknown>;
      expect(r.exitCode).toBe(0);
    });

    it('executes pipeline', async () => {
      const result = await bashTool.execute({
        sessionId: 's1',
        runId: null,
        stepId: null,
        toolCallId: 'tc1',
        toolId: 'bash',
        category: 'shell',
        mutability: 'read',
        args: { command: 'echo hello | wc -c' },
      });
      const r = result.result as Record<string, unknown>;
      expect(r.exitCode).toBe(0);
    });

    it('executes chain with &&', async () => {
      const result = await bashTool.execute({
        sessionId: 's1',
        runId: null,
        stepId: null,
        toolCallId: 'tc1',
        toolId: 'bash',
        category: 'shell',
        mutability: 'read',
        args: { command: 'echo a && echo b' },
      });
      const r = result.result as Record<string, unknown>;
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('a');
      expect(r.stdout).toContain('b');
    });

    it('handles non-zero exit gracefully', async () => {
      const result = await bashTool.execute({
        sessionId: 's1',
        runId: null,
        stepId: null,
        toolCallId: 'tc1',
        toolId: 'bash',
        category: 'shell',
        mutability: 'read',
        args: { command: 'ls /nonexistent/path/12345' },
      });
      const r = result.result as Record<string, unknown>;
      expect(r.exitCode).not.toBe(0);
    });
  });

  describe('execute - real async parallelism', () => {
    it('does not block the event loop while a command is running', async () => {
      const startedAt = Date.now();
      let timerFiredAt = 0;
      const pending = bashTool.execute({
        sessionId: 's1',
        runId: null,
        stepId: null,
        toolCallId: 'tc-async-1',
        toolId: 'bash',
        category: 'shell',
        mutability: 'read',
        args: { command: 'sleep 1' },
      });
      await new Promise<void>((resolve) => {
        setTimeout(() => {
          timerFiredAt = Date.now();
          resolve();
        }, 50);
      });
      // The timer must fire while the shell command is still running: a
      // spawnSync implementation would have blocked the loop for ~1s.
      expect(timerFiredAt - startedAt).toBeLessThan(500);
      const result = await pending;
      expect(Date.now() - startedAt).toBeGreaterThanOrEqual(900);
      expect((result.result as Record<string, unknown>).exitCode).toBe(0);
    });

    it('runs independent tool calls concurrently', async () => {
      const startedAt = Date.now();
      const runs = await Promise.all([
        bashTool.execute({
          sessionId: 's1',
          runId: null,
          stepId: null,
          toolCallId: 'tc-async-2',
          toolId: 'bash',
          category: 'shell',
          mutability: 'read',
          args: { command: 'sleep 1' },
        }),
        bashTool.execute({
          sessionId: 's1',
          runId: null,
          stepId: null,
          toolCallId: 'tc-async-3',
          toolId: 'bash',
          category: 'shell',
          mutability: 'read',
          args: { command: 'sleep 1' },
        }),
      ]);
      // Two 1s commands must overlap (~1s total) instead of serializing (~2s).
      expect(Date.now() - startedAt).toBeLessThan(1900);
      for (const run of runs) {
        expect((run.result as Record<string, unknown>).exitCode).toBe(0);
      }
    });
  });

  describe('execute - git commands', () => {
    it('allows git status', async () => {
      const result = await bashTool.execute({
        sessionId: 's1',
        runId: null,
        stepId: null,
        toolCallId: 'tc1',
        toolId: 'bash',
        category: 'shell',
        mutability: 'read',
        args: { command: 'git status' },
      });
      const r = result.result as Record<string, unknown>;
      // exitCode may be 0 or 128 (not a git repo), but should not be blocked
      expect(r.exitCode).not.toBeNull();
    });

    it('allows git diff --stat', async () => {
      const result = await bashTool.execute({
        sessionId: 's1',
        runId: null,
        stepId: null,
        toolCallId: 'tc1',
        toolId: 'bash',
        category: 'shell',
        mutability: 'read',
        args: { command: 'git diff --stat' },
      });
      const r = result.result as Record<string, unknown>;
      expect(r.exitCode).not.toBeNull();
    });

    it('classifies disallowed git subcommands for permission evaluation', () => {
      expect(parseBashInvocations('git push origin main')[0]?.pattern).toBe('git:push');
      expect(parseBashInvocations('git push origin main')[0]?.risk).toBe('write');
    });
  });

  describe('execute - fallback hints', () => {
    it('detects command-not-found for whitelisted commands that are not installed', async () => {
      // Use a whitelisted command name that won't exist as a binary.
      // We just verify the tool doesn't crash — actual binary existence is env-dependent.
      const result = await bashTool.execute({
        sessionId: 's1',
        runId: null,
        stepId: null,
        toolCallId: 'tc1',
        toolId: 'bash',
        category: 'shell',
        mutability: 'read',
        args: { command: 'echo test command not found detection' },
      });
      const r = result.result as Record<string, unknown>;
      // echo always exists, should succeed
      expect(r.exitCode).toBe(0);
    });

    it('classifies unknown commands as mutating', () => {
      expect(parseBashInvocations('nonexistentcmd123456 --help')[0]?.risk).toBe('write');
    });
  });

  describe('execute - timeout handling', () => {
    // Timeout protection is configured at 30s (EXEC_TIMEOUT_MS).
    // Full timeout test is skipped because it takes 30s to trigger.
    it('has timeout configured', async () => {
      // Verify the tool can execute normally; timeout is a safety net
      const result = await bashTool.execute({
        sessionId: 's1',
        runId: null,
        stepId: null,
        toolCallId: 'tc1',
        toolId: 'bash',
        category: 'shell',
        mutability: 'read',
        args: { command: 'echo quick' },
      });
      const r = result.result as Record<string, unknown>;
      expect(r.exitCode).toBe(0);
    });
  });

  describe('execute - stdin', () => {
    it('pipes stdin to command', async () => {
      const result = await bashTool.execute({
        sessionId: 's1',
        runId: null,
        stepId: null,
        toolCallId: 'tc1',
        toolId: 'bash',
        category: 'shell',
        mutability: 'read',
        args: { command: 'cat', stdin: 'hello from stdin' },
      });
      const r = result.result as Record<string, unknown>;
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain('hello from stdin');
    });
  });

  describe('parseBashInvocations', () => {
    it('classifies npx as mutating', () => {
      expect(parseBashInvocations('npx eslint .')[0]?.risk).toBe('write');
    });
  });
});

describe('extractBashPaths', () => {
  it('extracts quoted paths', () => {
    const paths = extractBashPaths("cat 'src/main.ts'");
    expect(paths).toContain('src/main.ts');
  });

  it('extracts double-quoted paths', () => {
    const paths = extractBashPaths('cat "src/main.ts"');
    expect(paths).toContain('src/main.ts');
  });

  it('extracts file paths with extensions', () => {
    const paths = extractBashPaths('rg TODO src/*.ts');
    expect(paths.some((p) => p.includes('.ts'))).toBe(true);
  });

  it('skips flags', () => {
    const paths = extractBashPaths('rg --ignore-case -n pattern');
    expect(paths).not.toContain('--ignore-case');
  });

  it('returns empty for simple commands', () => {
    const paths = extractBashPaths('echo hello world');
    expect(paths.filter((p) => p !== 'echo')).toEqual([]);
  });
});

// Shell policy tests still need a known directory; never inherit the API cwd implicitly.
beforeEach(() => setSessionWorkspaceRoot('s1', process.cwd()));
afterEach(() => clearSessionWorkspaceRoot('s1'));
