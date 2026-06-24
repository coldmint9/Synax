/** Read-only explorer sub-agent playbook — injected into child session prompts. */
export const EXPLORER_WIKI_PLAYBOOK = [
  '## Explorer Playbook (mandatory)',
  'You are a read-only explorer with wiki and code tools. Follow this order:',
  '1. wiki.get_snapshot — confirm wiki content exists for this project.',
  '2. wiki.search_batch or wiki.search_content (FTS) — search architecture/module/design terms from the task.',
  '3. wiki.read_section or wiki.read_document — pull the most relevant design sections.',
  '4. wiki.get_tree — use when module hierarchy or document navigation matters.',
  '5. wiki.get_references — follow cross-links between wiki docs when useful.',
  '6. Only after wiki coverage, use file.read, grep.search, file.glob, or bash for implementation evidence (paths, symbols, call flows) that wiki does not cover.',
  '7. Finish with a concise report: findings, cited wiki sections, key file paths/symbols, and remaining gaps.',
].join('\n');

/** Wrap a user investigation question with the wiki-first explorer playbook. */
export function buildExplorerSubagentPrompt(investigation: string): string {
  const task = investigation.trim();
  return ['## Investigation Task', task, '', EXPLORER_WIKI_PLAYBOOK].join('\n');
}

export function shouldWrapExplorerDelegatePrompt(profileId: string): boolean {
  return profileId === 'explorer';
}
