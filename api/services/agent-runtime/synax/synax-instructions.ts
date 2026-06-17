import fs from 'node:fs';
import path from 'node:path';
import {
  SYNAX_DIR,
  SYNAX_RULES_DIR,
  SYNAX_LOCAL_FILENAME,
  SYNAX_MD_FILENAME,
  PROJECT_RULE_FILES,
  INSTRUCTION_FALLBACK_FILES,
  type LoadedInstructions,
} from './synax-context-types.js';

export function resolveInstructionWorkDir(startDir: string): string | null {
  let current = path.resolve(startDir);
  const root = path.parse(current).root;

  while (true) {
    if (instructionFileExists(current)) return current;
    if (current === root) break;
    current = path.dirname(current);
  }
  return null;
}

function instructionFileExists(dir: string): boolean {
  for (const name of PROJECT_RULE_FILES) {
    if (fs.existsSync(path.join(dir, name))) return true;
  }
  return false;
}

export function findPrimaryInstructionFile(workDir: string): string | null {
  for (const name of PROJECT_RULE_FILES) {
    const candidate = path.join(workDir, name);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

export function loadInstructionFile(filePath: string, workDir: string): LoadedInstructions | null {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return {
      sourceFile: path.basename(filePath),
      workDir,
      body: stripFrontmatter(raw).trim(),
      raw,
    };
  } catch {
    return null;
  }
}

export function loadProjectInstructions(workDir: string): LoadedInstructions | null {
  const resolved = resolveInstructionWorkDir(workDir) ?? workDir;
  const primary = findPrimaryInstructionFile(resolved);
  if (!primary) return null;
  return loadInstructionFile(primary, resolved);
}

/** All project rule files for system-prompt injection (SYNAX → CLAUDE → AGENTS + local). */
export function loadProjectRulesSection(workDir: string, maxChars = 24_000): string | null {
  const resolved = resolveInstructionWorkDir(workDir) ?? workDir;
  const parts: string[] = [];

  for (const name of PROJECT_RULE_FILES) {
    const filePath = path.join(resolved, name);
    if (!fs.existsSync(filePath)) continue;
    const loaded = loadInstructionFile(filePath, resolved);
    if (loaded?.body) {
      parts.push(`### ${name}\n\n${loaded.body}`);
    }
  }

  const localPath = path.join(resolved, SYNAX_LOCAL_FILENAME);
  if (fs.existsSync(localPath)) {
    const local = loadInstructionFile(localPath, resolved);
    if (local?.body) {
      parts.push(`### ${SYNAX_LOCAL_FILENAME}\n\n${local.body}`);
    }
  }

  if (parts.length === 0) return null;
  return truncateForPrompt(parts.join('\n\n'), maxChars);
}

export function loadMergedProjectInstructions(workDir: string): string | null {
  return loadProjectRulesSection(workDir);
}

export function loadScopedRules(workDir: string, relativePath: string): string[] {
  const rulesDir = path.join(workDir, SYNAX_DIR, SYNAX_RULES_DIR);
  if (!fs.existsSync(rulesDir)) return [];

  const normalized = relativePath.replace(/\\/g, '/');
  const matches: string[] = [];

  for (const entry of fs.readdirSync(rulesDir)) {
    if (!entry.endsWith('.md')) continue;
    const filePath = path.join(rulesDir, entry);
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const globs = parseRuleGlobs(raw);
      if (globs.length === 0 || globs.some((glob) => matchGlob(glob, normalized))) {
        const body = stripFrontmatter(raw).trim();
        if (body) matches.push(body);
      }
    } catch {
      continue;
    }
  }

  return matches;
}

function parseRuleGlobs(raw: string): string[] {
  const fm = parseFrontmatter(raw);
  if (!fm) return [];
  const globs: string[] = [];
  const block = fm.match(/globs:\s*\[([^\]]+)\]/);
  if (block) {
    for (const part of block[1].split(',')) {
      const cleaned = part.trim().replace(/^['"]|['"]$/g, '');
      if (cleaned) globs.push(cleaned);
    }
  }
  const lineMatches = fm.matchAll(/-\s*["']([^"']+)["']/g);
  for (const match of lineMatches) {
    if (match[1].includes('**') || match[1].includes('/')) globs.push(match[1]);
  }
  return globs;
}

function matchGlob(glob: string, filePath: string): boolean {
  const pattern = glob
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '§§')
    .replace(/\*/g, '[^/]*')
    .replace(/§§/g, '.*');
  return new RegExp(`^${pattern}$`).test(filePath);
}

export function stripFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, '');
}

export function parseFrontmatter(content: string): string | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match?.[1] ?? null;
}

export function hasLockedSection(content: string): boolean {
  return /<!--\s*synax:locked\b/.test(content);
}

export function truncateForPrompt(text: string, maxChars = 24_000): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 40)}\n\n[...truncated for context budget...]`;
}
