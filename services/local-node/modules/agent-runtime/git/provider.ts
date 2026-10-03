import { z } from 'zod/v4';
import type { RegisteredTool, SessionToolProvider } from '../contracts.js';
import { gitMrService } from '../../git-mr/service.js';
import { AgentPermissionError } from '../runtime-errors.js';
import { assertGitMrBinding } from './binding.js';
import { GIT_MR_PROVIDER_ID } from './constants.js';
import { loadGitSkill, validateGitSkills } from './skills.js';

const empty = z.object({}).strict();
const fileInput = z.object({ fileId: z.string().min(1).max(200) }).strict();
/** No root/MR/path inputs: all authority comes from the persisted server binding. */
function scopedTool<S extends z.ZodType>(id: string, description: string, schema: S, action: (projectId: string, mrId: string, args: z.output<S>) => Promise<unknown>, write = false): RegisteredTool {
  return {
    id, label: id, description, category: write ? 'write' : id === 'skill.load' ? 'skill' : 'read',
    internalGate: write ? 'write' : id === 'skill.load' ? 'skill' : 'none',
    mutability: write ? 'write' : 'read', resumeBehavior: write ? 'none' : 'auto', inputSchema: schema,
    getPattern: () => id,
    execute: async input => {
      const binding = assertGitMrBinding(input.sessionId);
      const mr = await gitMrService.get(binding.projectId, binding.mrId);
      if (mr.rootId !== binding.rootId || mr.agentSessionId !== input.sessionId) throw new AgentPermissionError('MR authority changed; reopen its Git manager session.');
      if (write) validateGitSkills();
      const args = schema.parse(input.args ?? {});
      const result = await action(binding.projectId, binding.mrId, args);
      return { result, displaySummary: `${id} completed for ${binding.mrId}`, artifacts: [] };
    },
  };
}
const tools: RegisteredTool[] = [
  scopedTool('git.mr.inspect', 'Read bound MR status, version, frozen OIDs, steps, checks and events.', empty, async (projectId, mrId) => {
    const mr = await gitMrService.get(projectId, mrId);
    const { worktree: _worktree, repository: _repository, commonDir: _commonDir, location: _location, ...safe } = mr;
    return safe;
  }),
  scopedTool('git.history.compare', 'Read the persisted frozen target/source sequence and actual integration step results; this is not a full commit log.', empty, async (projectId, mrId) => {
    const mr = await gitMrService.get(projectId, mrId);
    return { target: mr.target, targetOid: mr.targetOid, candidateOid: mr.candidateOid, steps: mr.steps, version: mr.version };
  }),
  scopedTool('git.conflicts.list', 'List changed/conflicted files in this MR.', empty, (projectId, mrId) => gitMrService.files(projectId, mrId)),
  scopedTool('git.diff.read', 'Read base, target, source and current result for a file ID from this MR. Large content requires bounded git.blob.read.', fileInput, async (projectId, mrId, args) => {
    const file = await gitMrService.file(projectId, mrId, args.fileId);
    const limit = 48_000;
    const { resolutionState: _resolutionState, ...boundedFile } = file;
    return { ...boundedFile, base: file.base.slice(0, limit), target: file.target.slice(0, limit), source: file.source.slice(0, limit), result: file.result.slice(0, limit),
      truncated: [file.base, file.target, file.source, file.result].some(text => text.length > limit), limit };
  }),
  scopedTool('git.blob.read', 'Read a bounded character range of a bound MR file side; no arbitrary blob or filesystem access.', z.object({ fileId: z.string().min(1).max(200), side: z.enum(['base', 'target', 'source', 'result']), offset: z.number().int().min(0).default(0), limit: z.number().int().min(1).max(48_000).default(24_000) }).strict(), async (projectId, mrId, args) => {
    const file = await gitMrService.file(projectId, mrId, args.fileId);
    const text = file[args.side as 'base' | 'target' | 'source' | 'result'];
    return { fileId: file.id, revision: file.revision, side: args.side, offset: args.offset, content: text.slice(args.offset, args.offset + args.limit), totalCharacters: text.length, truncated: args.offset + args.limit < text.length };
  }),
  scopedTool('git.resolution.propose', 'Store an immutable text conflict proposal. Does not apply it, run checks or update any branch.', z.object({ fileId: z.string().min(1).max(200), revision: z.string().min(1).max(256), content: z.string().max(2 * 1024 * 1024), rationale: z.string().min(1).max(16_000) }).strict(), (projectId, mrId, args) => gitMrService.propose(projectId, mrId, args), true),
  scopedTool('skill.load', 'Load one of the six version-pinned bundled Git operation skills. Project/local skills are forbidden.', z.object({ skillId: z.string().min(1).max(150) }).strict(), async (_projectId, _mrId, args) => loadGitSkill(args.skillId)),
];
export const gitMrToolProvider: SessionToolProvider = {
  id: GIT_MR_PROVIDER_ID,
  getTools(sessionId) { try { assertGitMrBinding(sessionId); return tools; } catch { return []; } },
  getHooks() { return []; },
};
