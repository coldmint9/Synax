import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { ToolExecutionInput } from '../contracts.js';
import { agentSessionRuntime } from '../session-runtime.js';
import { workStore } from '../work-store.js';
import { verificationTool } from '../tools/verification.js';
import { setSessionWorkspaceRoot } from '../tools/workspace.js';
import { executorInput, resetAgentRuntimeFixtures } from './agent-runtime-fixtures.js';

let root: string;
beforeEach(() => {
  resetAgentRuntimeFixtures();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-verification-'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

function setup(criteria: string[]) {
  const session = agentSessionRuntime.create({ ...executorInput, permissionTier: 'unrestricted' });
  setSessionWorkspaceRoot(session.id, root);
  const work = workStore.create(session.id, 'Verify change');
  work.acceptanceCriteria = criteria;
  workStore.save(work);
  const verify = (criterion?: string) => verificationTool.execute({
    sessionId: session.id, runId: 'run-verify', stepId: 'step-verify', toolCallId: 'tc-verify',
    toolId: 'verification.run', category: 'task', mutability: 'read',
    args: verificationTool.inputSchema!.parse({
      command: 'node -e "process.exit(0)"', purpose: 'Check source', scope: ['.'],
      ...(criterion === undefined ? {} : { criterion }),
    }),
  } as ToolExecutionInput);
  return { session, verify };
}

describe('verification acceptance criterion selection', () => {
  it('automatically binds an omitted or incorrectly paraphrased criterion when there is only one', async () => {
    const { session, verify } = setup(['Tests pass']);
    await verify();
    await verify('The test suite succeeds');
    expect(workStore.current(session.id)!.verifications.map(receipt => receipt.criterion))
      .toEqual(['Tests pass', 'Tests pass']);
  });

  it('normalizes only whitespace and saves the approved original for multiple criteria', async () => {
    const { session, verify } = setup(['Focused tests pass', '  Typecheck\n  passes  ']);
    await verify('Typecheck  passes');
    expect(workStore.current(session.id)!.verifications[0].criterion).toBe('  Typecheck\n  passes  ');
  });

  it('lists the permitted criteria on an ambiguous or incorrect selection without running', async () => {
    const { session, verify } = setup(['Focused tests pass', 'Typecheck passes']);
    await expect(verify('Everything works')).rejects.toThrow(/Focused tests pass.*Typecheck passes/s);
    await expect(verify()).rejects.toThrow(/Focused tests pass.*Typecheck passes/s);
    expect(workStore.current(session.id)!.verifications).toEqual([]);
  });

  it('does not guess when whitespace normalization matches two different approved criteria', async () => {
    const { session, verify } = setup(['Tests  pass', 'Tests pass']);
    await expect(verify('  Tests\n pass  ')).rejects.toThrow(/Tests  pass.*Tests pass/s);
    await verify('Tests pass');
    expect(workStore.current(session.id)!.verifications.map(receipt => receipt.criterion))
      .toEqual(['Tests pass']);
  });

  it('rejects an omitted criterion when there is no approved criterion', async () => {
    const { session, verify } = setup([]);
    await expect(verify()).rejects.toThrow(/criterion/i);
    await verify('Independent check');
    expect(workStore.current(session.id)!.verifications[0].criterion).toBe('Independent check');
  });
});

describe('verification timeout window', () => {
  it('advertises a timeoutMs window the model can raise', () => {
    const schema = verificationTool.inputSchema!;
    const parsed = schema.parse({
      command: 'echo hi', purpose: 'Check source', scope: ['.'], criterion: 'Tests pass',
    }) as { timeoutMs?: number };
    expect(parsed.timeoutMs).toBe(120_000);
    expect(schema.safeParse({
      command: 'echo hi', purpose: 'Check source', scope: ['.'], timeoutMs: 600_001,
    }).success).toBe(false);
  });

  it('keeps partial output and records an interrupted receipt when the window expires', async () => {
    const session = agentSessionRuntime.create({ ...executorInput, permissionTier: 'unrestricted' });
    setSessionWorkspaceRoot(session.id, root);
    const work = workStore.create(session.id, 'Slow check');
    work.acceptanceCriteria = ['Slow check passes'];
    workStore.save(work);
    const result = await verificationTool.execute({
      sessionId: session.id, runId: 'run-verify', stepId: 'step-verify', toolCallId: 'tc-timeout',
      toolId: 'verification.run', category: 'task', mutability: 'read',
      args: verificationTool.inputSchema!.parse({
        command: 'echo partial-verification; sleep 10', purpose: 'Check slow suite', scope: ['.'],
        criterion: 'Slow check passes', timeoutMs: 1000,
      }),
    } as ToolExecutionInput);
    const payload = result.result as {
      stdout?: string; stderr?: string; exitCode?: number | null; verification?: { status: string };
    };
    expect(payload.stdout).toContain('partial-verification');
    expect(payload.stdout).toContain('[TIMED OUT after 1s');
    expect(payload.stderr).toContain('larger timeoutMs');
    expect(payload.verification?.status).toBe('interrupted');
    expect(workStore.current(session.id)!.verifications.map(receipt => receipt.status))
      .toEqual(['interrupted']);
  }, 20_000);
});
