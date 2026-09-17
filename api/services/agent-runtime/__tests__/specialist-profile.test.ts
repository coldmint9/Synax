import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentProfile, AgentSession, PermissionRule } from '../contracts.js';
import { createSessionRequestSchema } from '../contracts.js';
import { resolveSessionPermissionRules } from '../permission-tiers.js';
import {
  SPECIALIST_PROFILE_ID,
  assertSpecialistToolAllowed,
  buildSpecialistChildInput,
  resolveSpecialistProfile,
  specialistBaseProfile,
  specialistSpecSchema,
  type SpecialistSpec,
} from '../specialist-profile.js';
import { clearSessionWorkspaceRoot, resolveWorkspacePath, setSessionWorkspaceRoot } from '../tools/workspace.js';

const roundtrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
let root: string;
let parent: AgentSession;
let parentProfile: AgentProfile;

function spec(overrides: Partial<SpecialistSpec> = {}): SpecialistSpec {
  return {
    name: 'Backend reviewer', role: 'Review backend security', instructions: 'Report concrete evidence.',
    capabilities: ['file.read', 'grep.search', 'task.create', 'task.update', 'skill.load'],
    skillIds: ['security-review'], ...overrides,
  };
}

function child(overrides: Partial<SpecialistSpec> = {}): AgentSession {
  const input = roundtrip(buildSpecialistChildInput(parent, { specialist: spec(overrides), prompt: 'Inspect the API.' }, parentProfile));
  return {
    ...roundtrip(parent), ...input, id: 'specialist-child', parentSessionId: parent.id,
    childSessionIds: [], skillIds: input.skillIds!, mcpServerIds: input.mcpServerIds!,
    thinkingMode: input.thinkingMode!, sessionMetadata: input.sessionMetadata!,
    permissionRules: [
      ...parent.permissionRules,
      ...resolveSessionPermissionRules(specialistBaseProfile.permissionDefaults, input),
      ...input.sessionMetadata!.alwaysPermissionRules as PermissionRule[],
    ],
  };
}

beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'synax-specialist-')));
  fs.mkdirSync(path.join(root, 'src'));
  fs.mkdirSync(path.join(root, 'other'));
  parentProfile = {
    ...roundtrip(specialistBaseProfile), id: 'synax', mode: 'primary', toolPolicy: { allowSubtasks: true },
    allowedCapabilities: [...specialistBaseProfile.allowedCapabilities, 'subagent.delegate', 'bash', 'human.ask', 'mcp.run'],
  };
  parent = {
    id: 'specialist-parent', projectId: 'project-specialist', nodeId: 'api-node',
    parentSessionId: null, childSessionIds: [], profileId: parentProfile.id,
    status: 'running', title: null, prompt: 'Implement the backend.', contextSnapshotId: null,
    thinkingMode: 'deep', reasoningEffort: 'high',
    permissionRules: [{ gate: 'read', pattern: '*', action: 'allow' }, { gate: 'write', pattern: '*', action: 'ask' }],
    createdAt: '2026-09-10T00:00:00Z', updatedAt: '2026-09-10T00:00:00Z',
    completedAt: null, resultSummary: null, blockedReason: null,
    skillIds: ['security-review'], mcpServerIds: ['external'], activeRunId: null, pendingResumeToken: null,
    sessionMetadata: { mode: 'chat', permissionTier: 'boundary', engine: 'external', goal: { status: 'executing' } },
  };
  setSessionWorkspaceRoot(parent.id, root);
});

afterEach(() => {
  clearSessionWorkspaceRoot(parent.id);
  clearSessionWorkspaceRoot('specialist-child');
  fs.rmSync(root, { recursive: true, force: true });
});

describe('specialist configuration', () => {
  it('exports a bounded static subagent profile without shell, external tools or delegation', () => {
    expect(specialistBaseProfile).toMatchObject({ id: SPECIALIST_PROFILE_ID, kind: 'executor', mode: 'subagent', allowsSubsessions: false });
    expect(specialistBaseProfile.toolPolicy?.allowSubtasks).toBe(false);
    expect(specialistBaseProfile.allowedCapabilities).toEqual(expect.arrayContaining(['file.read', 'file.write', 'edit', 'file.delete', 'task.create', 'skill.load']));
    expect(specialistBaseProfile.allowedCapabilities.some((id) => /bash|shell|mcp|delegate|human|adapt/.test(id))).toBe(false);
  });

  it('bounds and normalizes definitions, deduplicating without mutating the caller', () => {
    const raw = { name: ' Reviewer ', role: ' API ', instructions: ' Check auth ', capabilities: [' file.read ', 'file.read'], skillIds: [] };
    expect(specialistSpecSchema.parse(raw)).toEqual({ name: 'Reviewer', role: 'API', instructions: 'Check auth', capabilities: ['file.read'], skillIds: [] });
    expect(raw.name).toBe(' Reviewer ');
    expect(specialistSpecSchema.parse({ name: 'Reader', role: 'Reader', instructions: 'Read only' })).toMatchObject({ capabilities: [], skillIds: [] });
    for (const invalid of [
      { name: ' ' }, { name: 'x'.repeat(81) }, { role: 'x'.repeat(257) }, { instructions: 'x'.repeat(16_001) },
      { capabilities: Array(33).fill('file.read') }, { skillIds: Array(21).fill('id') },
      { writeScope: [] }, { writeScope: Array(33).fill('src') }, { unknown: true },
    ]) expect(specialistSpecSchema.safeParse({ ...spec(), ...invalid }).success).toBe(false);
  });

  it('builds an isolated read-only request with parent context and a durable normalized task', () => {
    const original = roundtrip(parent);
    const input = buildSpecialistChildInput(parent, {
      specialist: spec({ name: ' Backend reviewer ', capabilities: ['file.read', 'file.read', 'skill.load'] }),
      prompt: ' Inspect auth ', deliverable: ' Findings ', acceptanceCriteria: [' Cite paths ', 'Cite paths'],
    }, parentProfile);
    expect(createSessionRequestSchema.safeParse(input).success).toBe(true);
    expect(input).toMatchObject({
      projectId: parent.projectId, nodeId: parent.nodeId, parentSessionId: parent.id, profileId: 'specialist',
      thinkingMode: 'deep', reasoningEffort: 'high', permissionTier: 'boundary', mcpServerIds: [],
      permissionOverrides: { shell: 'deny', write: 'deny', delete: 'deny' },
      sessionMetadata: {
        mode: 'chat', workspaceRoot: root,
        specialist: { version: 1, name: 'Backend reviewer', capabilities: ['file.read', 'skill.load'],
          parentMode: 'chat', projectId: parent.projectId, parentSessionId: parent.id, workspaceRoot: root,
          prompt: 'Inspect auth', deliverable: 'Findings', acceptanceCriteria: ['Cite paths'], permissionRules: parent.permissionRules },
      },
    });
    expect(input.prompt).toContain('Deliverable: Findings');
    expect(input.prompt).toContain('- Cite paths');
    expect(input.sessionMetadata).not.toHaveProperty('engine');
    expect(input.sessionMetadata).not.toHaveProperty('goal');
    expect(parent).toEqual(original);
  });

  it.each(['chat', 'goal', 'plan', 'plan_node'])('inherits %s mode instead of inventing broader child execution', (mode) => {
    parent.sessionMetadata!.mode = mode;
    const input = buildSpecialistChildInput(parent, { specialist: spec(), prompt: 'Review', thinkingMode: 'fast' }, parentProfile);
    expect(input.sessionMetadata!.mode).toBe(mode);
    expect(input.sessionMetadata!.specialist).toMatchObject({ parentMode: mode });
    expect(input.thinkingMode).toBe('fast');
  });

  it.each(['bash', 'shell', 'mcp.run', 'subagent.delegate', 'human.ask', 'plan.propose', 'plan.execute', 'mode.switch', 'agent.adapt', 'external.execute', 'file.*', '*'])('rejects unsafe capability %s even when the parent has it', (capability) => {
    parentProfile.allowedCapabilities.push(capability);
    expect(() => child({ capabilities: [capability] })).toThrow(/cannot use capability/);
  });

  it('rejects capabilities beyond the parent effective profile and unassigned skills', () => {
    parentProfile.allowedCapabilities = ['subagent.delegate', 'file.read'];
    expect(() => child()).toThrow(/parent effective profile/);
    expect(() => child({ capabilities: ['file.read'], skillIds: ['unassigned'] })).toThrow(/not assigned/);
    parentProfile.allowedCapabilities = ['file.read'];
    expect(() => child({ capabilities: ['file.read'], skillIds: [] })).toThrow(/cannot delegate/);
  });

  it('rejects a second child level and mismatched effective profile', () => {
    parent.parentSessionId = 'grandparent';
    expect(() => child()).toThrow(/one level/);
    parent.parentSessionId = null;
    parent.sessionMetadata!.specialist = {};
    expect(() => child()).toThrow(/one level/);
    delete parent.sessionMetadata!.specialist;
    parentProfile.id = 'different';
    expect(() => child()).toThrow(/cannot delegate/);
  });

  it('respects disabled profiles, delegation policy, and parent delegation denies', () => {
    parentProfile.status = 'disabled';
    expect(() => child()).toThrow(/cannot delegate/);
    parentProfile.status = 'active';
    parentProfile.toolPolicy = { allowSubtasks: false };
    expect(() => child()).toThrow(/cannot delegate/);
    parentProfile.toolPolicy = { allowSubtasks: true };
    parent.permissionRules.push({ gate: 'task', pattern: '*', action: 'deny' });
    expect(() => child({ capabilities: [] })).toThrow(/Parent permissions deny/);
  });

  it('bounds task payloads and refuses caller-supplied context or permission escalation', () => {
    for (const extra of [
      { prompt: ' ' }, { prompt: 'x'.repeat(20_001) }, { deliverable: 'x'.repeat(4_001) },
      { acceptanceCriteria: Array(21).fill('criterion') }, { acceptanceCriteria: ['x'.repeat(1_001)] },
      { thinkingMode: 'invalid' }, { projectId: 'outside' }, { permissionTier: 'unrestricted' }, { mode: 'goal' },
    ]) expect(() => buildSpecialistChildInput(parent, { specialist: spec(), prompt: 'Review', ...extra } as never, parentProfile)).toThrow(/Invalid specialist configuration/);
  });

  it('requires a safe explicit write scope and rejects all plan-mode writes', () => {
    expect(() => child({ capabilities: ['file.write'] })).toThrow(/writeScope/);
    parent.sessionMetadata!.mode = 'plan';
    for (const capability of ['file.write', 'edit', 'file.delete']) {
      expect(() => child({ capabilities: [capability], writeScope: ['src'] })).toThrow(/Plan specialists cannot write/);
    }
  });

  it('preserves parent deny/ask rules after child tier defaults without inheriting unrestricted access', () => {
    parent.sessionMetadata!.permissionTier = 'unrestricted';
    parent.sessionMetadata!.permissionOverrides = { read: 'ask', write: 'ask', delete: 'deny', shell: 'allow' };
    parent.permissionRules = [
      { gate: '*', pattern: '*', action: 'allow' },
      { gate: 'write', pattern: '*', action: 'ask' },
      { gate: 'write', pattern: 'src/private/*', action: 'deny' },
    ];
    const input = buildSpecialistChildInput(parent, { specialist: spec({ capabilities: ['file.write'], writeScope: ['src'] }), prompt: 'Update' }, parentProfile);
    expect(input.permissionTier).toBe('auto');
    expect(input.permissionOverrides).toMatchObject({ read: 'ask', write: 'ask', delete: 'deny', shell: 'deny' });
    expect((input.sessionMetadata!.alwaysPermissionRules as PermissionRule[]).slice(0, 3)).toEqual(parent.permissionRules);
    const session = child({ capabilities: ['file.write'], writeScope: ['src'] });
    expect(() => assertSpecialistToolAllowed(session, 'file.write', { path: 'src/public/new.ts' })).not.toThrow();
    expect(() => assertSpecialistToolAllowed(session, 'file.write', { path: 'src/private/key.ts' })).toThrow(/Parent permissions deny/);
    parent.permissionRules.push({ gate: 'write', pattern: '*', action: 'deny' });
    expect(() => child({ capabilities: ['file.write'], writeScope: ['src'] })).toThrow(/Parent permissions deny/);
  });
});

describe('persisted specialist resolution and execution boundary', () => {
  it('reconstructs label, hints, capabilities and workspace from JSON alone without registering profiles', () => {
    const baseBefore = roundtrip(specialistBaseProfile);
    const input = buildSpecialistChildInput(parent, { specialist: spec({ capabilities: ['file.write', 'skill.load'], writeScope: ['./src/'] }),
      prompt: 'Fix auth', deliverable: 'Code', acceptanceCriteria: ['No bypass'],
    }, parentProfile);
    const session = roundtrip({ ...child({ capabilities: ['file.write', 'skill.load'], writeScope: ['src'] }), sessionMetadata: input.sessionMetadata! });
    clearSessionWorkspaceRoot(parent.id);
    setSessionWorkspaceRoot(session.id, path.join(root, 'other'));
    const profile = resolveSpecialistProfile(roundtrip(specialistBaseProfile), session);
    expect(profile).toMatchObject({ id: 'specialist', label: 'Backend reviewer', description: 'Review backend security', kind: 'executor', mode: 'subagent', allowedCapabilities: ['file.write', 'skill.load'], allowsSubsessions: false });
    expect(profile.loopHints).toEqual(expect.arrayContaining(['Report concrete evidence.', 'Task: Fix auth', 'Deliverable: Code', 'Acceptance criterion: No bypass']));
    profile.allowedCapabilities.push('bash');
    expect(resolveSpecialistProfile(roundtrip(specialistBaseProfile), session).allowedCapabilities).not.toContain('bash');
    expect(specialistBaseProfile).toEqual(baseBefore);
    expect(() => assertSpecialistToolAllowed(session, 'file.write', { path: 'src/new.ts' })).not.toThrow();
    expect(resolveWorkspacePath('src/new.ts', session.id)).toBe(path.join(root, 'src/new.ts'));
  });

  it('does not alias parent rules, requested arrays or sibling snapshots', () => {
    const requested = spec({ capabilities: ['file.read'] });
    const input = buildSpecialistChildInput(parent, { specialist: requested, prompt: 'Review' }, parentProfile);
    requested.capabilities.push('bash');
    parent.permissionRules[0].action = 'deny';
    const snapshot = input.sessionMetadata!.specialist as SpecialistSpec & { permissionRules: PermissionRule[] };
    expect(snapshot.capabilities).toEqual(['file.read']);
    expect(snapshot.permissionRules[0].action).toBe('allow');
  });

  it('is a no-op for normal sessions and fails closed for missing, malformed or foreign snapshots', () => {
    expect(resolveSpecialistProfile(parentProfile, parent)).toBe(parentProfile);
    expect(() => assertSpecialistToolAllowed(parent, 'bash', {})).not.toThrow();
    const session = child();
    for (const invalid of [undefined, {}, { ...(session.sessionMetadata!.specialist as object), capabilities: ['bash'] }]) {
      const changed = { ...session, sessionMetadata: { specialist: invalid } };
      expect(() => resolveSpecialistProfile(specialistBaseProfile, changed)).toThrow();
      expect(() => assertSpecialistToolAllowed(changed, 'file.read', { path: 'src/a' })).toThrow();
    }
    expect(() => resolveSpecialistProfile(specialistBaseProfile, { ...session, projectId: 'foreign' })).toThrow(/does not match/);
    expect(() => resolveSpecialistProfile(specialistBaseProfile, { ...session, parentSessionId: null })).toThrow(/does not match/);
  });

  it('cannot use unassigned tools or skills, even after permission escalation or restart', () => {
    const session = child();
    session.permissionRules = [{ gate: '*', pattern: '*', action: 'allow' }];
    session.skillIds.push('not-in-snapshot');
    for (const tool of ['bash', 'mcp.run', 'human.ask', 'subagent.delegate', 'file.write', 'file.delete', 'edit']) {
      expect(() => assertSpecialistToolAllowed(roundtrip(session), tool, { path: 'src/x' })).toThrow(/not assigned/);
    }
    expect(() => assertSpecialistToolAllowed(session, 'skill.load', { skillId: 'not-in-snapshot' })).toThrow(/outside/);
    expect(() => assertSpecialistToolAllowed(session, 'skill.load', { skillId: 'security-review' })).not.toThrow();
    session.skillIds = [];
    expect(() => assertSpecialistToolAllowed(session, 'skill.load', { skillId: 'security-review' })).toThrow(/outside/);
  });

  it('keeps default children read-only even when their parent is unrestricted', () => {
    parent.sessionMetadata!.permissionTier = 'unrestricted';
    parent.permissionRules = [{ gate: '*', pattern: '*', action: 'allow' }];
    const session = child({ capabilities: ['file.read'], skillIds: [] });
    expect(session.sessionMetadata!.permissionTier).toBe('boundary');
    expect(session.permissionRules.at(-2)).toMatchObject({ gate: 'write', action: 'deny' });
    expect(session.permissionRules.at(-1)).toMatchObject({ gate: 'delete', action: 'deny' });
    expect(() => assertSpecialistToolAllowed(session, 'file.write', { path: 'src/x' })).toThrow(/not assigned/);
  });

  it('allows local task state tools but refuses plan writes after mode changes', () => {
    const reader = child();
    expect(() => assertSpecialistToolAllowed(reader, 'task.create', {})).not.toThrow();
    const writer = child({ capabilities: ['file.write'], writeScope: ['src'] });
    writer.sessionMetadata!.mode = 'plan';
    expect(() => assertSpecialistToolAllowed(writer, 'file.write', { path: 'src/a' })).toThrow(/Plan specialists/);
  });

  it.each(['../outside', 'src/../../outside', '/tmp/absolute', 'C:/outside', 'C:outside', 'src\\..\\outside', '\\\\server/share', 'src/%2e%2e/outside', '.', './', '*', 'src/*', 'src/a\0b', 'src/key.pem', 'src/cert.p12'])('rejects unsafe writeScope and write path %j', (unsafe) => {
    expect(() => child({ capabilities: ['file.write'], writeScope: [unsafe] })).toThrow();
    const session = child({ capabilities: ['file.write'], writeScope: ['src'] });
    expect(() => assertSpecialistToolAllowed(session, 'file.write', { path: unsafe })).toThrow();
  });

  it('allows formerly blocked segment names while still rejecting blocked extensions', () => {
    // `.env`, `.git` and `.ssh` are no longer restricted segments.
    for (const allowed of ['.env', '.git/config', '.ssh/key']) {
      expect(() => child({ capabilities: ['file.write'], writeScope: [allowed] })).not.toThrow();
      const session = child({ capabilities: ['file.write'], writeScope: [allowed] });
      expect(() => assertSpecialistToolAllowed(session, 'file.write', { path: allowed })).not.toThrow();
    }
    // The remaining extension rule still applies.
    for (const blocked of ['src/key.pem', 'src/cert.p12']) {
      const session = child({ capabilities: ['file.write'], writeScope: ['src'] });
      expect(() => assertSpecialistToolAllowed(session, 'file.write', { path: blocked })).toThrow();
    }
  });

  it('enforces exact path or directory boundaries for all file mutations, not string prefixes', () => {
    const session = child({ capabilities: ['file.write', 'file.delete', 'edit'], writeScope: ['src/module', 'src/single.ts'] });
    for (const tool of ['file.write', 'file.delete', 'edit']) {
      expect(() => assertSpecialistToolAllowed(session, tool, { path: 'src/module/nested/new.ts' })).not.toThrow();
      expect(() => assertSpecialistToolAllowed(session, tool, { path: 'src/single.ts' })).not.toThrow();
      expect(() => assertSpecialistToolAllowed(session, tool, { path: 'src/module-other/new.ts' })).toThrow(/writeScope/);
      expect(() => assertSpecialistToolAllowed(session, tool, { path: 'src/single.ts.bak' })).toThrow(/writeScope/);
      expect(() => assertSpecialistToolAllowed(session, tool, {})).toThrow();
    }
  });

  it('rejects existing and dangling symlinks, scope aliases, and symlinked new-file ancestors', () => {
    fs.symlinkSync(path.join(root, 'other'), path.join(root, 'src/link'));
    fs.symlinkSync(path.join(root, 'missing'), path.join(root, 'src/dangling'));
    fs.symlinkSync(os.tmpdir(), path.join(root, 'src/outside'));
    const session = child({ capabilities: ['file.write'], writeScope: ['src'] });
    for (const target of ['src/link/new/deep.ts', 'src/dangling', 'src/outside/new/deep.ts']) {
      expect(() => assertSpecialistToolAllowed(session, 'file.write', { path: target })).toThrow();
      expect(() => child({ capabilities: ['file.write'], writeScope: [target] })).toThrow();
    }
  });

  it('does not permit deletion or movement hidden inside an edit patch', () => {
    const session = child({ capabilities: ['edit'], writeScope: ['src'] });
    expect(() => assertSpecialistToolAllowed(session, 'edit', { path: 'src/a.ts', patch: '*** Begin Patch\n*** Add File: src/a.ts\n+hello\n*** End Patch' })).not.toThrow();
    const deletion = '*** Begin Patch\n*** Delete File: src/a.ts\n*** End Patch';
    expect(() => assertSpecialistToolAllowed(session, 'edit', { path: 'src/a.ts', patch: deletion })).toThrow(/file.delete/);
    expect(() => assertSpecialistToolAllowed(session, 'edit', { path: 'src/a.ts', patch: '*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: other/a.ts\n@@\n-old\n+new\n*** End Patch' })).toThrow(/without moves/);
    expect(() => assertSpecialistToolAllowed(session, 'edit', { path: 'src/a.ts', patch: '*** Begin Patch\n*** Add File: other/a.ts\n+hello\n*** End Patch' })).toThrow(/scoped path/);
    expect(() => assertSpecialistToolAllowed(session, 'edit', { path: 'src/a.ts', patch: '*** Begin Patch\n*** Add File: src/a.ts\n+hello\n*** Delete File: other/a.ts\n*** End Patch' })).toThrow(/exactly/);
    const deleter = child({ capabilities: ['edit', 'file.delete'], writeScope: ['src'] });
    expect(() => assertSpecialistToolAllowed(deleter, 'edit', { path: 'src/a.ts', patch: deletion })).not.toThrow();
  });
});
