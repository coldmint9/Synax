import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getRawSqlite } from '../../../infrastructure/database/index.js';
import type { AgentProfileKind } from '../../agent-runtime/contracts.js';
import { AgentPermissionError } from '../../agent-runtime/runtime-errors.js';
import { agentSessionRuntime } from '../../agent-runtime/session-runtime.js';
import * as workspace from '../../agent-runtime/tools/workspace.js';
import {
  explorerSessionInput,
  resetAgentRuntimeFixtures,
} from '../../agent-runtime/__tests__/agent-runtime-fixtures.js';
import { skillAgentBridge } from '../agent-bridge.js';
import { skillPreferences } from '../skill-preferences.js';
import { skillRegistry } from '../skill-registry.js';

const projectId = explorerSessionInput.projectId;
const name = 'synax-explore';
const projectSkillId = `project/${name}`;
const builtinSkillId = `synax-builtin/${name}`;
let root: string;

beforeEach(() => {
  resetAgentRuntimeFixtures();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'synax-skill-eligibility-'));
  vi.spyOn(workspace, 'resolveProjectWorkDir').mockReturnValue(root);
});

afterEach(() => {
  vi.restoreAllMocks();
  getRawSqlite()
    .prepare('DELETE FROM skill_preferences WHERE skill_id = ? AND scope = ?')
    .run(projectSkillId, projectId);
  fs.rmSync(root, { recursive: true, force: true });
});

function writeProjectSkill(appliesTo: AgentProfileKind[], profileIds: string[] = []) {
  const directory = path.join(root, '.synax', 'skills', name);
  fs.mkdirSync(directory, { recursive: true });
  fs.writeFileSync(path.join(directory, 'SKILL.md'), [
    '---',
    `name: ${name}`,
    'description: Project eligibility regression fixture',
    'synax:',
    `  applies-to: [${appliesTo.join(', ')}]`,
    `  profile-ids: [${profileIds.join(', ')}]`,
    '---',
    'Project eligibility content.',
  ].join('\n'));
}

function listedIds(includeDisabled = false) {
  return skillRegistry.listSummaries({
    projectId,
    profileId: 'explorer',
    includeDisabled,
  }).filter((skill) => skill.name === name).map((skill) => skill.id);
}

describe('real registry candidate eligibility before name precedence', () => {
  it('retains project precedence when the project skill is eligible', () => {
    writeProjectSkill(['explorer']);
    expect(listedIds()).toEqual([projectSkillId]);
  });

  it('falls back to builtin when the project skill is disabled and retains it in management', () => {
    writeProjectSkill(['explorer']);
    skillPreferences.setEnabled(projectSkillId, false, projectId);

    expect(listedIds()).toEqual([builtinSkillId]);
    expect(listedIds(true)).toEqual([projectSkillId]);
    expect(skillRegistry.listSummaries({ projectId, includeDisabled: true }))
      .toContainEqual(expect.objectContaining({ id: projectSkillId, status: 'disabled' }));
    expect(skillRegistry.listSummaries({ projectId, includeDisabled: true, includeUnmounted: true }))
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: projectSkillId, status: 'disabled' }),
        expect.objectContaining({ id: builtinSkillId, status: 'available' }),
      ]));
    expect(skillAgentBridge.listForPrompt({
      profileId: 'explorer', projectId, activeSkillIds: [],
    }).filter((skill) => skill.name === name).map((skill) => skill.id))
      .toEqual([builtinSkillId]);
    expect(() => skillRegistry.loadDetail({ skillId: projectSkillId, projectId })).toThrow();
  });

  it.each([
    { appliesTo: ['executor'] as AgentProfileKind[], profileIds: [] },
    { appliesTo: ['explorer'] as AgentProfileKind[], profileIds: ['reviewer'] },
  ])('falls back to builtin for an ineligible project profile: %j', ({ appliesTo, profileIds }) => {
    writeProjectSkill(appliesTo, profileIds);
    expect(listedIds()).toEqual([builtinSkillId]);
    expect(skillRegistry.listSummaries({ projectId, sourceId: 'project', profileId: 'explorer' }))
      .toEqual([]);
  });
});

describe('real bridge profile matching agrees with registry', () => {
  it.each([
    { appliesTo: ['executor'], profileIds: ['explorer'], allowed: true, profileKind: 'explorer' },
    { appliesTo: ['explorer'], profileIds: ['reviewer'], allowed: false, profileKind: 'explorer' },
    { appliesTo: ['explorer'], profileIds: [], allowed: true, profileKind: 'explorer' },
    { appliesTo: ['executor'], profileIds: [], allowed: false, profileKind: 'explorer' },
    { appliesTo: [], profileIds: [], allowed: true, profileKind: 'explorer' },
    { appliesTo: ['executor'], profileIds: [], allowed: false, profileKind: 'executor' },
  ] satisfies Array<{
    appliesTo: AgentProfileKind[];
    profileIds: string[];
    allowed: boolean;
    profileKind: AgentProfileKind;
  }>)('uses session profile with profileIds precedence: %j', ({ appliesTo, profileIds, allowed, profileKind }) => {
    writeProjectSkill(appliesTo, profileIds);
    const session = agentSessionRuntime.create(explorerSessionInput);
    const load = () => skillAgentBridge.loadForTool({
      sessionId: session.id,
      skillId: projectSkillId,
      profileKind,
    });

    expect(listedIds()).toEqual([allowed ? projectSkillId : builtinSkillId]);
    if (allowed) {
      expect(load()).toMatchObject({ id: projectSkillId, content: 'Project eligibility content.' });
    } else {
      expect(load).toThrow(AgentPermissionError);
      expect(load).toThrow(`Skill ${projectSkillId} does not apply to explorer.`);
    }
  });
});
