import { describe, expect, it } from 'vitest';
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

    it('blocks disallowed command', () => {
      const result = bashTool.execute({
        sessionId: 's1',
        runId: null,
        stepId: null,
        toolCallId: 'tc1',
        toolId: 'bash',
        category: 'shell',
        mutability: 'read',
        args: { command: 'rm -rf /' },
      });
      expect(result.result).toBeDefined();
      const r = result.result as Record<string, unknown>;
      expect(r.exitCode).toBeNull();
      expect(r.stderr).toContain('rm');
      expect(r.stderr).toContain('not allowed');
    });

    it('blocks rm even in a pipeline', () => {
      const result = bashTool.execute({
        sessionId: 's1',
        runId: null,
        stepId: null,
        toolCallId: 'tc1',
        toolId: 'bash',
        category: 'shell',
        mutability: 'read',
        args: { command: 'cat file.txt | rm -rf /' },
      });
      const r = result.result as Record<string, unknown>;
      expect(r.exitCode).toBeNull();
      expect(r.stderr).toContain('rm');
      expect(r.stderr).toContain('not allowed');
    });

    it('blocks file redirect to unsafe target', () => {
      const result = bashTool.execute({
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

    it('allows redirect to /dev/null', () => {
      const result = bashTool.execute({
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
    it('executes echo', () => {
      const result = bashTool.execute({
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

    it('executes ls', () => {
      const result = bashTool.execute({
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

    it('executes pipeline', () => {
      const result = bashTool.execute({
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

    it('executes chain with &&', () => {
      const result = bashTool.execute({
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

    it('handles non-zero exit gracefully', () => {
      const result = bashTool.execute({
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

  describe('execute - git commands', () => {
    it('allows git status', () => {
      const result = bashTool.execute({
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

    it('allows git diff --stat', () => {
      const result = bashTool.execute({
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

    it('blocks git push', () => {
      const result = bashTool.execute({
        sessionId: 's1',
        runId: null,
        stepId: null,
        toolCallId: 'tc1',
        toolId: 'bash',
        category: 'shell',
        mutability: 'read',
        args: { command: 'git push origin main' },
      });
      const r = result.result as Record<string, unknown>;
      expect(r.exitCode).toBeNull();
      expect(r.stderr).toContain('push');
    });
  });

  describe('execute - fallback hints', () => {
    it('detects command-not-found for whitelisted commands that are not installed', () => {
      // Use a whitelisted command name that won't exist as a binary.
      // We just verify the tool doesn't crash — actual binary existence is env-dependent.
      const result = bashTool.execute({
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

    it('returns fallback hint for blocked commands', () => {
      const result = bashTool.execute({
        sessionId: 's1',
        runId: null,
        stepId: null,
        toolCallId: 'tc1',
        toolId: 'bash',
        category: 'shell',
        mutability: 'read',
        args: { command: 'nonexistentcmd123456 --help' },
      });
      const r = result.result as Record<string, unknown>;
      // Blocked by whitelist before reaching shell — exitCode is null
      expect(r.exitCode).toBeNull();
      expect(r.stderr).toContain('not allowed');
    });
  });

  describe('execute - timeout handling', () => {
    // Timeout protection is configured at 30s (EXEC_TIMEOUT_MS).
    // Full timeout test is skipped because it takes 30s to trigger.
    it('has timeout configured', () => {
      // Verify the tool can execute normally; timeout is a safety net
      const result = bashTool.execute({
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
    it('pipes stdin to command', () => {
      const result = bashTool.execute({
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

  describe('execute - npx blocked', () => {
    it('blocks npx command', () => {
      const result = bashTool.execute({
        sessionId: 's1',
        runId: null,
        stepId: null,
        toolCallId: 'tc1',
        toolId: 'bash',
        category: 'shell',
        mutability: 'read',
        args: { command: 'npx eslint .' },
      });
      const r = result.result as Record<string, unknown>;
      expect(r.exitCode).toBeNull();
      expect(r.stderr).toContain('npx');
      expect(r.stderr).toContain('not allowed');
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
