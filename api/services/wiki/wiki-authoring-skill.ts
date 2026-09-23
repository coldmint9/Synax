/**
 * Resolves the wiki-authoring writing guide for the document-writer prompt.
 *
 * Order: project override → global override → inlined baseline. The first two are
 * best-effort filesystem reads; the baseline is a compile-time constant, so the
 * guide remains available unless the user explicitly detaches it from this project.
 */
import fs from 'node:fs';
import { extensionStore } from '../extensions/extension-store.js';
import path from 'node:path';
import { logger } from '../../lib/logger.js';
import { parseSkillMarkdown } from '../skills/skill-parser.js';
import { resolveGlobalSkillsRoot, resolveProjectSkillsRoot } from '../skills/paths.js';
import { WIKI_AUTHORING_BUILTIN_BODY } from './generated/wiki-authoring-builtin.js';

const SKILL_DIR_NAME = 'wiki-authoring';

export type WikiAuthoringOrigin = 'project' | 'global' | 'builtin' | 'disabled';

export interface WikiAuthoringGuide {
  body: string;
  origin: WikiAuthoringOrigin;
}

function readOverride(root: string | null): string | null {
  if (!root) return null;
  const file = path.join(root, SKILL_DIR_NAME, 'SKILL.md');
  try {
    if (!fs.existsSync(file)) return null;
    const { frontmatter, body: rawBody } = parseSkillMarkdown(fs.readFileSync(file, 'utf8'));
    const synax = (frontmatter.synax ?? {}) as Record<string, unknown>;
    if (frontmatter.name !== SKILL_DIR_NAME || synax.injection !== 'deterministic') {
      logger.warn({ file }, 'wiki-authoring: override is not a wiki-authoring deterministic skill, ignoring');
      return null;
    }
    const body = rawBody.trim();
    if (!body) {
      logger.warn({ file }, 'wiki-authoring: override has an empty body, falling back');
      return null;
    }
    return body;
  } catch (error) {
    logger.warn({ file, error }, 'wiki-authoring: override unreadable, falling back');
    return null;
  }
}

export function resolveWikiAuthoringGuide(
  input: { projectId?: string; workDir?: string | null } = {},
): WikiAuthoringGuide {
  const projectBody = readOverride(
    resolveProjectSkillsRoot(input.projectId ?? '', input.workDir ?? null),
  );
  if (projectBody && extensionStore.active(input.projectId, 'skill', 'project/wiki-authoring')) return { body: projectBody, origin: 'project' };

  const globalBody = readOverride(resolveGlobalSkillsRoot());
  if (globalBody && extensionStore.active(input.projectId, 'skill', 'local/wiki-authoring')) return { body: globalBody, origin: 'global' };

  if (!extensionStore.active(input.projectId, 'skill', 'synax-builtin/wiki-authoring')) return { body: '', origin: 'disabled' };
  return { body: WIKI_AUTHORING_BUILTIN_BODY, origin: 'builtin' };
}
