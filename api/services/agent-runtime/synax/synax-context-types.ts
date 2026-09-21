export const SYNAX_MD_FILENAME = 'SYNAX.md';
export const CLAUDE_MD_FILENAME = 'CLAUDE.md';
export const AGENTS_MD_FILENAME = 'AGENTS.md';
export const SYNAX_DIR = '.synax';
export const SYNAX_RULES_DIR = 'rules';

/**
 * Project rule files injected into every agent system prompt.
 * Order is precedence order: later files win conflicts, so AGENTS.md is the
 * canonical rules file and CLAUDE.md is the fallback. SYNAX.md and
 * SYNAX.local.md are deprecated as rule sources and are no longer loaded;
 * SYNAX.md remains a generated repo playbook artifact (see synax-md.ts).
 */
export const PROJECT_RULE_FILES = [
  CLAUDE_MD_FILENAME,
  AGENTS_MD_FILENAME,
] as const;

export interface LoadedInstructions {
  sourceFile: string;
  workDir: string;
  body: string;
  raw: string;
}
