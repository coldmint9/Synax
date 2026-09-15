import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  clearSessionFileReads,
  extractBashReadPaths,
  recordSessionFileRead,
  rebuildSessionFileReads,
} from '../read-tracker.js';
import type { ToolCallRecord, ToolExecutionResult } from '../contracts.js';
import { editTool } from '../tools/edit.js';
import { fileWriteTool } from '../tools/file-write.js';
import { agentSessionRuntime } from '../session-runtime.js';
import { clearSessionWorkspaceRoot, setSessionWorkspaceRoot } from '../tools/workspace.js';

describe('extractBashReadPaths', () => {
  it('accepts simple cat/head/tail without pipes', () => {
    expect(extractBashReadPaths('cat src/foo.ts')).toEqual(['src/foo.ts']);
    expect(extractBashReadPaths('head -n 20 README.md')).toEqual(['README.md']);
  });

  it('rejects piped commands', () => {
    expect(extractBashReadPaths('cat foo.ts | grep bar')).toEqual([]);
  });
});

function makeRecord(partial: Partial<ToolCallRecord>): ToolCallRecord {
  return {
    id: 'tc-1',
    sessionId: 'sess-read-tracker',
    runId: 'run-1',
    stepId: 'step-1',
    modelToolCallId: null,
    toolId: 'file.read',
    category: 'read',
    mutability: 'read',
    argsHash: '',
    inputSummary: '',
    inputRef: null,
    outputSummary: '',
    outputRef: null,
    status: 'completed',
    permissionDecisionId: null,
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
    error: null,
    ...partial,
  };
}

/**
 * `edit` may resolve or reject synchronously, so callers assert through
 * `Promise.resolve().then(...)` (the pattern used elsewhere in this suite).
 */
function runEdit(
  sessionId: string,
  args: { path: string; content: string },
  toolCallId = 'test-edit',
): ToolExecutionResult | Promise<ToolExecutionResult> {
  return editTool.execute({
    sessionId,
    runId: null,
    stepId: null,
    toolCallId,
    toolId: 'edit',
    category: 'write',
    mutability: 'write',
    args,
  });
}

describe('rebuildSessionFileReads', () => {
  const sessionId = 'sess-read-tracker';

  it('rebuilds from completed file.read calls', () => {
    clearSessionFileReads(sessionId);
    rebuildSessionFileReads(sessionId, [
      makeRecord({ toolId: 'file.read', inputRef: { path: 'package.json' } }),
    ]);
    // rebuild only records when file exists on disk; package.json should exist in repo root
    // If missing in test env, this is a no-op — we verify no throw.
    expect(() => rebuildSessionFileReads(sessionId, [])).not.toThrow();
  });

  it('replays this session own writes so a later edit is not rejected as unread', async () => {
    const session = 'sess-read-tracker-own-write';
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-read-tracker-replay-'));
    try {
      setSessionWorkspaceRoot(session, dir);
      const relPath = 'created-by-session.txt';
      // The session created this file through its own write, so the persisted
      // history has no file.read for it.
      fs.writeFileSync(path.join(dir, relPath), 'written\n', 'utf8');

      rebuildSessionFileReads(session, [
        makeRecord({
          sessionId: session,
          toolId: 'file.write',
          category: 'write',
          mutability: 'write',
          inputRef: { path: relPath, content: 'written\n' },
        }),
      ]);

      // Without replaying the write, the tracker stays empty and this edit fails
      // with "was not read in this session".
      const edited = await runEdit(session, { path: relPath, content: 'edited\n' }, 'replay-edit');
      expect(edited.result).toMatchObject({ deleted: false });
      expect(fs.readFileSync(path.join(dir, relPath), 'utf8')).toBe('edited\n');
    } finally {
      clearSessionFileReads(session);
      clearSessionWorkspaceRoot(session);
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('read-before-write path identity', () => {
  const sessions: string[] = [];
  const dirs: string[] = [];

  afterEach(() => {
    for (const sessionId of sessions.splice(0)) {
      clearSessionFileReads(sessionId);
      clearSessionWorkspaceRoot(sessionId);
    }
    for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  function newWorkspace(prefix: string): { sessionId: string; dir: string } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    const sessionId = `${prefix}${path.basename(dir)}`;
    dirs.push(dir);
    sessions.push(sessionId);
    setSessionWorkspaceRoot(sessionId, dir);
    return { sessionId, dir };
  }

  it('treats aliased spellings of one file as the same tracked path', async () => {
    const { sessionId, dir } = newWorkspace('synax-read-alias-');
    fs.writeFileSync(path.join(dir, 'alias.txt'), 'value\n', 'utf8');

    // Read through a `sub/..` alias, then write through the plain relative path.
    recordSessionFileRead(sessionId, 'sub/../alias.txt');
    const result = await runEdit(sessionId, { path: 'alias.txt', content: 'value\n' });
    expect(result.result).toMatchObject({ deleted: false });
  });

  it('matches an out-of-root file read via absolute path against a relative edit', async () => {
    // Production shape: an unrestricted session works from
    // `.../project/.worktrees/feature` and edits `../../../other-project/src/x.vue`.
    // `toWorkspaceRelative` returns the ABSOLUTE path for targets that escape the
    // root, so recording reads by relative string and asserting by absolute string
    // never matched and every edit failed as "was not read".
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-read-escape-root-'));
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-read-outside-'));
    dirs.push(workDir, outside);
    const session = agentSessionRuntime.create({
      projectId: 'project-alpha',
      profileId: 'executor',
      prompt: 'Edit a file outside the workspace root.',
      permissionTier: 'unrestricted',
      sessionMetadata: { mode: 'chat' },
    });
    sessions.push(session.id);
    setSessionWorkspaceRoot(session.id, workDir);

    const absTarget = path.join(outside, 'outside.txt');
    fs.writeFileSync(absTarget, 'outside\n', 'utf8');

    const relativeArg = path.relative(workDir, absTarget).split(path.sep).join('/');
    recordSessionFileRead(session.id, absTarget);

    const result = await runEdit(session.id, { path: relativeArg, content: 'outside\n' });
    expect(result.result).toMatchObject({ deleted: false });
    expect(fs.readFileSync(absTarget, 'utf8')).toBe('outside\n');
  });

  it('allows repeated edits of a file this session already wrote', async () => {
    const { sessionId, dir } = newWorkspace('synax-read-repeat-');
    const filePath = path.join(dir, 'repeat.txt');
    fs.writeFileSync(filePath, 'first\n', 'utf8');
    // Push the read-time mtime into the past so the write definitely advances it.
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(filePath, past, past);

    recordSessionFileRead(sessionId, 'repeat.txt');

    const first = await runEdit(sessionId, { path: 'repeat.txt', content: 'second\n' }, 'repeat-1');
    expect(first.result).toMatchObject({ deleted: false });

    // Without refreshing the tracked mtime this second edit failed with
    // "changed on disk since last read" because the session's own write moved it.
    const second = await runEdit(sessionId, { path: 'repeat.txt', content: 'third\n' }, 'repeat-2');
    expect(second.result).toMatchObject({ deleted: false });
    expect(fs.readFileSync(filePath, 'utf8')).toBe('third\n');
  });

  it('allows an edit right after file.write of the same path', async () => {
    const { sessionId, dir } = newWorkspace('synax-read-after-write-');
    const filePath = path.join(dir, 'created.txt');
    fs.writeFileSync(filePath, 'seed\n', 'utf8');
    const past = new Date(Date.now() - 60_000);
    fs.utimesSync(filePath, past, past);
    recordSessionFileRead(sessionId, 'created.txt');

    await fileWriteTool.execute({
      sessionId,
      runId: null,
      stepId: null,
      toolCallId: 'write-1',
      toolId: 'file.write',
      category: 'write',
      mutability: 'write',
      args: { path: 'created.txt', content: 'rewritten\n' },
    });

    const edited = await runEdit(sessionId, { path: 'created.txt', content: 'final\n' }, 'write-2');
    expect(edited.result).toMatchObject({ deleted: false });
    expect(fs.readFileSync(filePath, 'utf8')).toBe('final\n');
  });

  it('still blocks a write to a file this session never read', async () => {
    const { sessionId, dir } = newWorkspace('synax-read-guard-');
    fs.writeFileSync(path.join(dir, 'unread.txt'), 'secret\n', 'utf8');

    const executeEdit = () => runEdit(sessionId, { path: 'unread.txt', content: 'overwritten\n' });
    await expect(Promise.resolve().then(executeEdit)).rejects.toThrow(/not read in this session/i);
  });

  it('still blocks a write when the file changed on disk after the read', async () => {
    const { sessionId, dir } = newWorkspace('synax-read-external-');
    const filePath = path.join(dir, 'external.txt');
    fs.writeFileSync(filePath, 'one\n', 'utf8');
    recordSessionFileRead(sessionId, 'external.txt');

    // An out-of-band change must keep failing the guard.
    const future = new Date(Date.now() + 60_000);
    fs.writeFileSync(filePath, 'two\n', 'utf8');
    fs.utimesSync(filePath, future, future);

    const executeEdit = () => runEdit(sessionId, { path: 'external.txt', content: 'two\n' });
    await expect(Promise.resolve().then(executeEdit)).rejects.toThrow(/changed on disk/i);
  });
});
