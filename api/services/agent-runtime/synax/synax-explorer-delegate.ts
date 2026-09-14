/** Read-only explorer sub-agent playbook — injected into child session prompts. */
export const EXPLORER_WIKI_PLAYBOOK = [
  '## Explorer Playbook',
  'Investigate the assigned question read-only. Do not implement changes or delegate it again.',
  'Use attached Wiki evidence when relevant; search code directly when Wiki is absent or insufficient. Do not run a fixed sequence of tools.',
  'Return concise findings, evidence references and unresolved gaps. Stop when the assigned question is answered.',
].join('\n');

/** Wrap a user investigation question with the wiki-first explorer playbook. */
export function buildExplorerSubagentPrompt(investigation: string): string {
  const task = investigation.trim();
  return ['## Investigation Task', task, '', EXPLORER_WIKI_PLAYBOOK].join('\n');
}

export function shouldWrapExplorerDelegatePrompt(profileId: string): boolean {
  return profileId === 'explorer';
}
