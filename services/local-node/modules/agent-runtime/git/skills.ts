import fs from 'node:fs';
import path from 'node:path';
import type { SkillDetail } from '../../skills/types.js';
import { createHash } from 'node:crypto';
import { resolveBuiltinSkillsRoot } from '../../skills/paths.js';
import { parseSkillFile } from '../../skills/skill-parser.js';
import { AgentPermissionError } from '../runtime-errors.js';
import { GIT_SKILL_DIGESTS, GIT_SKILL_VERSION } from './skill-manifest.js';

export function loadGitSkill(id: string): SkillDetail {
  const name = id.startsWith('synax-builtin/') ? id.slice('synax-builtin/'.length) : id;
  if (!Object.hasOwn(GIT_SKILL_DIGESTS, name)) throw new AgentPermissionError('Only bundled Git operation skills may be loaded.');
  const file = path.join(resolveBuiltinSkillsRoot(), name, 'SKILL.md');
  const raw = fs.readFileSync(file, 'utf8');
  const digest = createHash('sha256').update(raw).digest('hex');
  if (digest !== GIT_SKILL_DIGESTS[name]) throw new AgentPermissionError(`Bundled Git skill integrity mismatch: ${name}`);
  const parsed = parseSkillFile(file);
  if (parsed.version !== GIT_SKILL_VERSION || parsed.profileIds?.join() !== 'git-manager') throw new AgentPermissionError('Git skill version/profile mismatch.');
  return { ...parsed, id: `synax-builtin/${name}`, sourceId: 'synax-builtin', sourceKind: 'builtin', status: 'available', installed: true, contentDigest: digest };
}
export function validateGitSkills(): void { for (const name of Object.keys(GIT_SKILL_DIGESTS)) loadGitSkill(name); }

export function listGitSkills() {
  return Object.keys(GIT_SKILL_DIGESTS).filter(name => name !== 'git-operation-contract').map(name => {
    const { content: _content, ...summary } = loadGitSkill(name);
    return summary;
  });
}
