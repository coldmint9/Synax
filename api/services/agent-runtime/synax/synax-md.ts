import fs from 'node:fs';
import path from 'node:path';
import type { CodeMapScanResult } from '../../contracts/code-map.js';
import { derivePackages } from '../../wiki/tools/package-baseline.js';
import { SYNAX_MD_FILENAME } from './synax-context-types.js';
import { hasLockedSection } from './synax-instructions.js';

interface PackageJsonShape {
  name?: string;
  scripts?: Record<string, string>;
}

export function readPackageJson(workDir: string): PackageJsonShape | null {
  try {
    const raw = fs.readFileSync(path.join(workDir, 'package.json'), 'utf8');
    return JSON.parse(raw) as PackageJsonShape;
  } catch {
    return null;
  }
}

function formatCommands(scripts: Record<string, string> | undefined): string {
  if (!scripts || Object.keys(scripts).length === 0) {
    return '_No npm scripts detected._';
  }
  const preferred = ['dev', 'typecheck', 'lint', 'test', 'build'];
  const lines: string[] = [];
  for (const key of preferred) {
    if (scripts[key]) lines.push(`- \`npm run ${key}\` — ${scripts[key]}`);
  }
  for (const [key, cmd] of Object.entries(scripts)) {
    if (preferred.includes(key)) continue;
    if (lines.length >= 12) break;
    lines.push(`- \`npm run ${key}\` — ${cmd}`);
  }
  return lines.join('\n');
}

function formatPackages(scan: CodeMapScanResult | undefined): string {
  if (!scan) return '_Run a wiki scan or code-map scan to populate package boundaries._';
  const packages = derivePackages(scan).slice(0, 8);
  if (packages.length === 0) return '_No packages derived from scan._';
  return packages
    .map((pkg) => `- **${pkg.label}** (\`${pkg.dirPath}/\`) — ${pkg.fileCount} files`)
    .join('\n');
}

export function buildSynaxMdContent(input: {
  workDir: string;
  projectId: string;
  scan?: CodeMapScanResult;
  wikiLandscapeTitle?: string | null;
}): string {
  const pkg = readPackageJson(input.workDir);
  const name = pkg?.name ?? path.basename(input.workDir);
  const wikiLine = input.wikiLandscapeTitle
    ? `Open Wiki → **${input.wikiLandscapeTitle}** (landscape entry). Use wiki tools for module design.`
    : 'Wiki not generated yet. Run wiki generate for architecture docs.';

  return [
    `# ${name}`,
    '',
    'Synax project playbook. **Do not duplicate Wiki or Code Map here** — they are injected at session start.',
    '',
    '## Commands',
    '',
    formatCommands(pkg?.scripts),
    '',
    '## Where to look',
    '',
    `- **Wiki**: ${wikiLine}`,
    '- **Code map**: package boundaries and entry files are injected from the latest scan cache.',
    '- **Coordinates**: graph UI for cross-module impact.',
    '',
    '## Packages',
    '',
    formatPackages(input.scan),
    '',
    '## Team notes',
    '',
    '_Add conventions, review rules, and footguns here. Synax will not auto-edit this section._',
    '',
  ].join('\n');
}

/** Create SYNAX.md if missing; refresh machine sections when not locked. */
export function ensureSynaxMd(input: {
  workDir: string;
  projectId: string;
  scan?: CodeMapScanResult;
  wikiLandscapeTitle?: string | null;
}): { created: boolean; updated: boolean } {
  const filePath = path.join(input.workDir, SYNAX_MD_FILENAME);
  const fresh = buildSynaxMdContent(input);

  if (!fs.existsSync(filePath)) {
    fs.mkdirSync(input.workDir, { recursive: true });
    fs.writeFileSync(filePath, fresh, 'utf8');
    return { created: true, updated: false };
  }

  const existing = fs.readFileSync(filePath, 'utf8');
  if (hasLockedSection(existing)) return { created: false, updated: false };

  const teamNotes = extractTeamNotes(existing);
  const next = teamNotes
    ? replaceTeamNotes(fresh, teamNotes)
    : fresh;

  if (next === existing) return { created: false, updated: false };
  fs.writeFileSync(filePath, next, 'utf8');
  return { created: false, updated: true };
}

function extractTeamNotes(content: string): string | null {
  const match = content.match(/## Team notes\n([\s\S]*?)$/);
  if (!match) return null;
  const body = match[1].trim();
  if (!body || body === '_Add conventions, review rules, and footguns here. Synax will not auto-edit this section._') {
    return null;
  }
  return body;
}

function replaceTeamNotes(template: string, teamNotes: string): string {
  return template.replace(
    /## Team notes\n\n[\s\S]*$/,
    `## Team notes\n\n${teamNotes}\n`,
  );
}
