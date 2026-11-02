import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agentSessionRuntime } from '../session-runtime.js';
import { agentRuntimeStore as store } from '../session-store.js';
import { ToolRegistry } from '../tool-registry.js';
import { workStore } from '../work-store.js';
import { workRuntime } from '../work-runtime.js';
import { receiptReport, supersededReceipts } from '../evidence-inventory.js';
import * as fingerprints from '../work-fingerprint.js';
import { ensureSynaxAgentRegistered } from '../synax/index.js';
import { clearSessionWorkspaceRoot, setSessionWorkspaceRoot } from '../tools/workspace.js';
import { resetAgentRuntimeFixtures } from './agent-runtime-fixtures.js';

let root: string;
let sessionId: string;
let registry: ToolRegistry;

beforeEach(async () => {
  await resetAgentRuntimeFixtures();
  ensureSynaxAgentRegistered();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-change-tracking-'));
  fs.writeFileSync(path.join(root, 'source.ts'), 'original\n');
  const session = agentSessionRuntime.create({ projectId: 'project-alpha', profileId: 'synax',
    prompt: 'Verify edits', permissionTier: 'unrestricted', sessionMetadata: { mode: 'goal' } });
  sessionId = session.id;
  setSessionWorkspaceRoot(sessionId, root);
  store.updateSession(sessionId, { status: 'running' });
  store.updateSessionMetadata(sessionId, { plan: { status: 'approved', acceptanceCriteria: ['Check passes'] } });
  const work = workStore.create(sessionId, 'Verify edits');
  work.acceptanceCriteria = ['Check passes'];
  workStore.save(work);
  registry = new ToolRegistry();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await store.flush();
  clearSessionWorkspaceRoot(sessionId);
  fs.rmSync(root, { recursive: true, force: true });
});

function verify(command = 'true') {
  return registry.execute(sessionId, 'verification.run', {
    command, purpose: 'Check source', scope: ['.'], timeoutMs: 5_000,
  });
}

describe('workspace change tracking without per-command fingerprints', () => {
  it('executes inspections without scanning or changing the work version', async () => {
    const scan = vi.spyOn(fingerprints, 'workspaceFingerprint');
    for (const command of ['pwd', 'ls', 'cat source.ts']) {
      const result = await registry.execute(sessionId, 'bash', { command, timeoutMs: 5_000 });
      expect(result.record.status, result.record.error ?? '').toBe('completed');
    }
    expect(scan).not.toHaveBeenCalled();
    expect(workStore.current(sessionId)).toMatchObject({ hasChanges: false, changeVersion: 0 });
    expect(workStore.current(sessionId)?.workspaceDirty).not.toBe(true);
  });

  it('coalesces opaque commands without invalidating unchanged verification contents', async () => {
    const verified = await verify();
    expect(verified.toolResult?.result).toMatchObject({ verification: { status: 'success' } });
    const scan = vi.spyOn(fingerprints, 'workspaceFingerprint');
    for (const command of ['true', 'printf ok', 'true']) {
      const result = await registry.execute(sessionId, 'bash', { command, timeoutMs: 5_000 });
      expect(result.record.status, result.record.error ?? '').toBe('completed');
    }
    expect(scan).not.toHaveBeenCalled();
    const work = workStore.current(sessionId)!;
    expect(work).toMatchObject({ workspaceDirty: true, changeVersion: 0, hasChanges: false });
    expect(supersededReceipts([work]).size).toBe(0);
    expect((await receiptReport([work])).current.has(verified.record.id)).toBe(true);
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it('tracks write, move and delete paths directly and invalidates old receipts without scanning', async () => {
    const verified = await verify();
    const scan = vi.spyOn(fingerprints, 'workspaceFingerprint');
    const written = await registry.execute(sessionId, 'file.write', { path: 'new.ts', content: 'created\n' });
    expect(written.record.status, written.record.error ?? '').toBe('completed');
    const moved = await registry.execute(sessionId, 'file.patch', {
      patch: '*** Begin Patch\n*** Update File: new.ts\n*** Move to: moved.ts\n@@\n-created\n+updated\n*** End Patch',
    });
    expect(moved.record.status, moved.record.error ?? '').toBe('completed');
    const removed = await registry.execute(sessionId, 'file.delete', { path: 'moved.ts' });
    expect(removed.record.status, removed.record.error ?? '').toBe('completed');
    const work = workStore.current(sessionId)!;
    expect(work).toMatchObject({ hasChanges: true, changeVersion: 3, changedPaths: ['new.ts', 'moved.ts'] });
    expect((await receiptReport([work])).superseded.has(verified.record.id)).toBe(true);
    expect(scan).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(root, 'moved.ts'))).toBe(false);
  });

  it('retains dirty state and detects partial shell writes even when execution throws', async () => {
    const verified = await verify();
    const scan = vi.spyOn(fingerprints, 'workspaceFingerprint');
    registry.register({ ...registry.get('bash'), execute: () => {
      fs.writeFileSync(path.join(root, 'source.ts'), 'partial edit\n');
      throw new Error('command interrupted after writing');
    } });
    const result = await registry.execute(sessionId, 'bash', { command: 'opaque-command', timeoutMs: 5_000 });
    expect(result.record.status).toBe('failed');
    expect(workStore.current(sessionId)).toMatchObject({ workspaceDirty: true, changeVersion: 0 });
    expect(scan).not.toHaveBeenCalled();
    expect((await receiptReport([workStore.current(sessionId)!])).superseded.get(verified.record.id)?.reason)
      .toContain('scope changed');
  });

  it('does not mark work dirty for rejected tool arguments', async () => {
    const scan = vi.spyOn(fingerprints, 'workspaceFingerprint');
    const result = await registry.execute(sessionId, 'file.write', { path: 'new.ts', content: 123 });
    expect(result.record.status).toBe('failed');
    expect(workStore.current(sessionId)?.workspaceDirty).not.toBe(true);
    expect(workStore.current(sessionId)?.changeVersion).toBe(0);
    expect(scan).not.toHaveBeenCalled();
  });

  it.each([true, false])('does not scan MCP calls and honors declared read-only metadata (%s)', async readOnly => {
    const scan = vi.spyOn(fingerprints, 'workspaceFingerprint');
    registry.register({ id: 'mcp.fixture', label: 'Fixture', description: 'Fixture tool',
      category: 'mcp', mutability: 'read', resumeBehavior: 'auto', codeModeReadOnly: readOnly,
      execute: () => ({ result: { ok: true }, displaySummary: 'Done', artifacts: [] }) });
    const result = await registry.execute(sessionId, 'mcp.fixture', {});
    expect(result.record.status, result.record.error ?? '').toBe('completed');
    expect(Boolean(workStore.current(sessionId)?.workspaceDirty)).toBe(!readOnly);
    expect(scan).not.toHaveBeenCalled();
  });

  it('scans twice for successful verification and once for an unsuccessful check', async () => {
    const scan = vi.spyOn(fingerprints, 'workspaceFingerprint');
    expect((await verify()).toolResult?.result).toMatchObject({ verification: { status: 'success' } });
    expect(scan).toHaveBeenCalledTimes(2);
    scan.mockClear();
    const failed = await verify('false');
    expect(failed.toolResult?.result, failed.record.error ?? '').toMatchObject({ verification: { status: 'failed' } });
    expect(scan).toHaveBeenCalledTimes(1);
  });

  it('rejects a successful command as verification when inputs changed during it', async () => {
    const scan = vi.spyOn(fingerprints, 'workspaceFingerprint');
    const result = await verify('printf changed > source.ts');
    expect(result.toolResult?.result).toMatchObject({ exitCode: 0, verification: { status: 'failed' } });
    expect(result.toolResult?.displaySummary).toContain('inputs changed');
    expect(workStore.current(sessionId)).toMatchObject({ hasChanges: true, changeVersion: 1 });
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it('shares acceptance scans but always checks again after external edits', async () => {
    const verified = await verify();
    const work = workStore.current(sessionId)!;
    const receipt = work.verifications[0];
    work.verifications.push({ ...receipt, toolCallId: 'second', criterion: 'Second criterion', scope: ['.', '.'] });
    work.verifications.push({ ...receipt, toolCallId: 'failed', status: 'failed' });
    work.verifications.push({ ...receipt, toolCallId: 'old-version', changeVersion: -1 });
    work.verifications.push({ ...receipt, toolCallId: 'external', external: true, runId: 'another-run' });
    workStore.save(work);
    const scan = vi.spyOn(fingerprints, 'workspaceFingerprint');
    const report = await receiptReport([work]);
    expect([...report.current]).toEqual([verified.record.id, 'second']);
    expect(scan).toHaveBeenCalledTimes(1);
    fs.writeFileSync(path.join(root, 'source.ts'), 'external edit\n');
    const changed = await receiptReport([work]);
    expect(changed.current.size).toBe(0);
    expect(changed.superseded.get(verified.record.id)?.reason).toContain('scope changed');
    expect(scan).toHaveBeenCalledTimes(2);
  });

  it('requires verification when only an opaque command may have changed files', async () => {
    const now = new Date().toISOString();
    const run = store.appendRun({ id: 'dirty-run', sessionId, status: 'running', startedAt: now,
      completedAt: null, triggerMessageId: null, currentStep: 1, stopReason: null, model: null, metadata: {} });
    store.updateSession(sessionId, { activeRunId: run.id });
    store.updateSessionMetadata(sessionId, { goal: null });
    workRuntime.markWorkspaceDirty(sessionId);
    const scan = vi.spyOn(fingerprints, 'workspaceFingerprint');
    await expect(workRuntime.complete({ sessionId, runId: run.id, stepId: 'step', toolCallId: 'finish',
      toolId: 'work.checkpoint', category: 'task', mutability: 'task', args: {} }, 'Done'))
      .rejects.toThrow('Missing current-version verification');
    expect(scan).not.toHaveBeenCalled();
  });
});
