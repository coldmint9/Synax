import fs from "node:fs";
import path from "node:path";
import {
  SYNAX_DIR,
  SYNAX_RULES_DIR,
  SYNAX_LOCAL_FILENAME,
  SYNAX_MD_FILENAME,
  CLAUDE_MD_FILENAME,
  AGENTS_MD_FILENAME,
  PROJECT_RULE_FILES,
  type LoadedInstructions,
} from "./synax-context-types.js";

export function resolveInstructionWorkDir(startDir: string): string | null {
  return (
    instructionDirectories(startDir).reverse().find(instructionFileExists) ??
    null
  );
}

/** A checkout may have a .git directory or a worktree's .git file. */
function instructionDirectories(startDir: string): string[] {
  const cwd = fs.realpathSync(startDir);
  const directories: string[] = [];
  for (let current = cwd; ; current = path.dirname(current)) {
    directories.push(current);
    if (fs.existsSync(path.join(current, ".git"))) return directories.reverse();
    if (current === path.dirname(current)) return [cwd];
  }
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

export function loadInstructionFile(
  filePath: string,
  workDir: string,
): LoadedInstructions | null {
  try {
    const raw = fs.readFileSync(filePath, "utf8");
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

export function loadProjectInstructions(
  workDir: string,
): LoadedInstructions | null {
  const resolved = resolveInstructionWorkDir(workDir) ?? workDir;
  const primary = findPrimaryInstructionFile(resolved);
  if (!primary) return null;
  return loadInstructionFile(primary, resolved);
}

export type ProjectRulesScope = "all" | "synax-only";

const PROJECT_RULE_FILE_BUDGETS: Record<string, number> = {
  [SYNAX_MD_FILENAME]: 4_000,
  [CLAUDE_MD_FILENAME]: 8_000,
  [AGENTS_MD_FILENAME]: 4_000,
  [SYNAX_LOCAL_FILENAME]: 2_000,
};

const TOTAL_PROJECT_RULES_CAP = 18_000;

export function stripPromptBloat(body: string): string {
  return body
    .replace(
      /<!-- HEROUI-REACT-AGENTS-MD-START -->[\s\S]*?<!-- HEROUI-REACT-AGENTS-MD-END -->/g,
      "",
    )
    .trim();
}

function prepareRuleBody(body: string): string {
  return stripPromptBloat(stripFrontmatter(body).trim());
}

/** All project rule files for system-prompt injection (SYNAX → CLAUDE → AGENTS + local). */
export function loadProjectRulesSection(
  workDir: string,
  options: { maxChars?: number; scope?: ProjectRulesScope } = {},
): string | null {
  const { maxChars = TOTAL_PROJECT_RULES_CAP, scope = "all" } = options;
  let directories: string[];
  try {
    directories = instructionDirectories(workDir);
  } catch (error) {
    return truncateForPrompt(
      `[Project rules unavailable: ${(error as NodeJS.ErrnoException).code ?? "read error"}]`,
      maxChars,
    );
  }
  const root = directories[0];
  const parts: Array<{ heading: string; body: string }> = [];
  const files =
    scope === "synax-only"
      ? [SYNAX_MD_FILENAME]
      : [...PROJECT_RULE_FILES, SYNAX_LOCAL_FILENAME];
  for (const directory of directories) {
    for (const name of files) {
      const filePath = path.join(directory, name);
      const source = path.relative(root, filePath).split(path.sep).join("/");
      let body: string;
      try {
        try {
          fs.lstatSync(filePath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") continue;
          throw error;
        }
        const realPath = fs.realpathSync(filePath);
        const relative = path.relative(root, realPath);
        if (
          relative === ".." ||
          relative.startsWith(`..${path.sep}`) ||
          path.isAbsolute(relative)
        ) {
          body = "[Rule unavailable: symlink outside the project rule root.]";
        } else if (!fs.statSync(realPath).isFile()) {
          body = "[Rule unavailable: not a regular file.]";
        } else {
          body = prepareRuleBody(fs.readFileSync(realPath, "utf8"));
        }
      } catch (error) {
        body = `[Rule unavailable: ${(error as NodeJS.ErrnoException).code ?? "read error"}]`;
      }
      if (body)
        parts.push({
          heading: `### ${JSON.stringify(source).replace(/</g, "\\u003c")}\n\n`,
          body: truncateForPrompt(body, PROJECT_RULE_FILE_BUDGETS[name]),
        });
    }
  }
  if (parts.length === 0) return null;
  const precedence = `Project rule order: root to cwd; ${scope === "synax-only" ? "SYNAX.md only" : "within each directory SYNAX.md, CLAUDE.md, AGENTS.md, then SYNAX.local.md"}. Later rules take precedence within user authorization and runtime limits.\n\n`;
  const full =
    precedence + parts.map(({ heading, body }) => heading + body).join("\n\n");
  if (full.length <= maxChars) return full;

  const omitted =
    "[...lower-priority rules omitted or truncated for context budget...]\n\n";
  let remaining = maxChars - precedence.length - omitted.length;
  const kept: string[] = [];
  for (const { heading, body } of parts.toReversed()) {
    const bodyBudget = remaining - heading.length - (kept.length ? 2 : 0);
    if (bodyBudget < PROMPT_TRUNCATION_MARKER.length) break;
    const section = heading + truncateForPrompt(body, bodyBudget);
    kept.unshift(section);
    remaining -= section.length + (kept.length > 1 ? 2 : 0);
  }
  return (precedence + omitted + kept.join("\n\n")).slice(
    0,
    Math.max(0, maxChars),
  );
}

export function loadMergedProjectInstructions(workDir: string): string | null {
  return loadProjectRulesSection(workDir);
}

export function loadScopedRules(
  workDir: string,
  relativePath: string,
): string[] {
  const rulesDir = path.join(workDir, SYNAX_DIR, SYNAX_RULES_DIR);
  if (!fs.existsSync(rulesDir)) return [];

  const normalized = relativePath.replace(/\\/g, "/");
  const matches: string[] = [];

  for (const entry of fs.readdirSync(rulesDir)) {
    if (!entry.endsWith(".md")) continue;
    const filePath = path.join(rulesDir, entry);
    try {
      const raw = fs.readFileSync(filePath, "utf8");
      const globs = parseRuleGlobs(raw);
      if (
        globs.length === 0 ||
        globs.some((glob) => matchGlob(glob, normalized))
      ) {
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
    for (const part of block[1].split(",")) {
      const cleaned = part.trim().replace(/^['"]|['"]$/g, "");
      if (cleaned) globs.push(cleaned);
    }
  }
  const lineMatches = fm.matchAll(/-\s*["']([^"']+)["']/g);
  for (const match of lineMatches) {
    if (match[1].includes("**") || match[1].includes("/")) globs.push(match[1]);
  }
  return globs;
}

function matchGlob(glob: string, filePath: string): boolean {
  const pattern = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, "§§")
    .replace(/\*/g, "[^/]*")
    .replace(/§§/g, ".*");
  return new RegExp(`^${pattern}$`).test(filePath);
}

export function stripFrontmatter(content: string): string {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

export function parseFrontmatter(content: string): string | null {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  return match?.[1] ?? null;
}

export function hasLockedSection(content: string): boolean {
  return /<!--\s*synax:locked\b/.test(content);
}

const PROMPT_TRUNCATION_MARKER = "\n\n[...truncated for context budget...]";

export function truncateForPrompt(text: string, maxChars = 24_000): string {
  if (text.length <= maxChars) return text;
  if (maxChars < PROMPT_TRUNCATION_MARKER.length)
    return PROMPT_TRUNCATION_MARKER.slice(0, Math.max(0, maxChars));
  return (
    text.slice(0, maxChars - PROMPT_TRUNCATION_MARKER.length) +
    PROMPT_TRUNCATION_MARKER
  );
}
