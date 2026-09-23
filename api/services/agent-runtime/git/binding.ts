import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { DATA_ROOT } from '../../../lib/env.js';
import { agentRuntimeStore } from '../session-store.js';
import { AgentPermissionError } from '../runtime-errors.js';
import { GIT_MANAGER_PROFILE_ID } from './constants.js';

export interface GitMrBinding { sessionId: string; projectId: string; mrId: string; rootId?: string }
function bindingPath(sessionId: string) {
  return path.join(DATA_ROOT, 'git-mr', 'agent-bindings', `${createHash('sha256').update(sessionId).digest('hex')}.json`);
}
/** Only the MR session creation service writes this authority; client session metadata is not authority. */
export function persistGitMrBinding(binding: GitMrBinding): void {
  const file = bindingPath(binding.sessionId);
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, JSON.stringify(binding), { flag: 'wx', mode: 0o600 });
}
export function assertGitMrBinding(sessionId: string): GitMrBinding {
  const session = agentRuntimeStore.tryGetSession(sessionId);
  if (!session || session.profileId !== GIT_MANAGER_PROFILE_ID || session.parentSessionId) {
    throw new AgentPermissionError('A dedicated Git manager session is required.');
  }
  let binding: GitMrBinding;
  try { binding = JSON.parse(fs.readFileSync(bindingPath(sessionId), 'utf8')) as GitMrBinding; }
  catch { throw new AgentPermissionError('This session has no server-authorized MR binding.'); }
  const metadata = session.sessionMetadata?.gitMr as GitMrBinding | undefined;
  if (binding.sessionId !== sessionId || binding.projectId !== session.projectId || !binding.mrId ||
      metadata?.mrId !== binding.mrId || metadata.projectId !== binding.projectId || metadata.rootId !== binding.rootId) {
    throw new AgentPermissionError('The MR session binding does not match.');
  }
  return binding;
}
