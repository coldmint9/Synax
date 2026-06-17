export const SYNAX_MD_FILENAME = 'SYNAX.md';
export const SYNAX_LOCAL_FILENAME = 'SYNAX.local.md';
export const CLAUDE_MD_FILENAME = 'CLAUDE.md';
export const AGENTS_MD_FILENAME = 'AGENTS.md';
export const SYNAX_DIR = '.synax';
export const SYNAX_RULES_DIR = 'rules';

/** Project rule files injected into every agent system prompt (in order). */
export const PROJECT_RULE_FILES = [
  SYNAX_MD_FILENAME,
  CLAUDE_MD_FILENAME,
  AGENTS_MD_FILENAME,
] as const;

/** @deprecated Use PROJECT_RULE_FILES */
export const INSTRUCTION_FALLBACK_FILES = [AGENTS_MD_FILENAME, CLAUDE_MD_FILENAME] as const;

export interface LoadedInstructions {
  sourceFile: string;
  workDir: string;
  body: string;
  raw: string;
}
