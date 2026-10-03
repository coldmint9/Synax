import fs from 'node:fs';
import path from 'node:path';
import { parseSkillFile } from './skill-parser.js';
import type { ParsedSkillFile } from './types.js';

export function scanSkillsDirectory(rootDir: string): ParsedSkillFile[] {
  if (!fs.existsSync(rootDir)) return [];

  const entries = fs.readdirSync(rootDir, { withFileTypes: true });
  const skills: ParsedSkillFile[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(rootDir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillPath)) continue;
    try {
      skills.push(parseSkillFile(skillPath));
    } catch {
      // Skip invalid skill folders during discovery.
    }
  }

  return skills.sort((a, b) => a.name.localeCompare(b.name));
}
