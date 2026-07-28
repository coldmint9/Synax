import fs from 'node:fs';
import path from 'node:path';
import type { AgentProfileKind, InternalGate } from '../agent-runtime/contracts.js';
import type { ParsedSkillFile, SkillInjectionMode } from './types.js';

const PROFILE_KINDS = new Set<AgentProfileKind>(['planner', 'executor', 'reviewer', 'explorer']);
const INTERNAL_GATES = new Set<InternalGate>(['none', 'write', 'delete', 'shell', 'task', 'skill', 'external_path']);
const INJECTION_MODES = new Set<SkillInjectionMode>(['on-demand', 'deterministic']);

function parseSimpleYamlBlock(block: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  let currentKey: string | null = null;
  let nested: Record<string, unknown> | null = null;

  for (const rawLine of block.split('\n')) {
    const line = rawLine.trimEnd();
    if (!line.trim() || line.trim().startsWith('#')) continue;

    const nestedMatch = line.match(/^  ([A-Za-z0-9_-]+):\s*(.*)$/);
    if (nested && nestedMatch) {
      nested[nestedMatch[1]!] = parseScalar(nestedMatch[2] ?? '');
      continue;
    }

    const topMatch = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (!topMatch) continue;

    const key = topMatch[1]!;
    const value = topMatch[2] ?? '';
    if (!value.trim()) {
      currentKey = key;
      nested = {};
      result[key] = nested;
      continue;
    }

    nested = null;
    currentKey = key;
    result[key] = parseScalar(value);
  }

  return result;
}

function parseScalar(raw: string): unknown {
  const value = raw.trim();
  if (!value) return '';
  if (value.startsWith('[') && value.endsWith(']')) {
    return value
      .slice(1, -1)
      .split(',')
      .map((part) => part.trim().replace(/^['"]|['"]$/g, ''))
      .filter(Boolean);
  }
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}

export function parseSkillMarkdown(raw: string): { frontmatter: Record<string, unknown>; body: string } {
  const trimmed = raw.replace(/^\uFEFF/, '').trimStart();
  if (!trimmed.startsWith('---')) {
    return { frontmatter: {}, body: trimmed };
  }

  const end = trimmed.indexOf('\n---', 3);
  if (end === -1) {
    return { frontmatter: {}, body: trimmed };
  }

  const frontmatterBlock = trimmed.slice(3, end).trim();
  const body = trimmed.slice(end + 4).replace(/^\s+/, '');
  return { frontmatter: parseSimpleYamlBlock(frontmatterBlock), body };
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === 'string');
}

function asProfileKinds(value: unknown): AgentProfileKind[] {
  return asStringArray(value).filter((item): item is AgentProfileKind => PROFILE_KINDS.has(item as AgentProfileKind));
}

function asInternalGates(value: unknown): InternalGate[] {
  return asStringArray(value).filter((item): item is InternalGate => INTERNAL_GATES.has(item as InternalGate));
}

function asInjectionMode(value: unknown): SkillInjectionMode {
  return typeof value === 'string' && INJECTION_MODES.has(value as SkillInjectionMode)
    ? (value as SkillInjectionMode)
    : 'on-demand';
}

export function parseSkillFile(installPath: string): ParsedSkillFile {
  const raw = fs.readFileSync(installPath, 'utf8');
  const { frontmatter, body } = parseSkillMarkdown(raw);
  const synax = (frontmatter.synax ?? {}) as Record<string, unknown>;
  const directoryName = path.basename(path.dirname(installPath));
  const name = typeof frontmatter.name === 'string' && frontmatter.name.trim()
    ? frontmatter.name.trim()
    : directoryName;
  const description = typeof frontmatter.description === 'string' ? frontmatter.description.trim() : '';
  if (!description) {
    throw new Error(`SKILL.md missing description: ${installPath}`);
  }

  return {
    name,
    label: typeof frontmatter.label === 'string' && frontmatter.label.trim() ? frontmatter.label.trim() : name,
    description,
    version: typeof frontmatter.version === 'string' && frontmatter.version.trim() ? frontmatter.version.trim() : '0.0.0',
    appliesTo: asProfileKinds(synax['applies-to'] ?? synax.appliesTo),
    profileIds: asStringArray(synax['profile-ids'] ?? synax.profileIds),
    injection: asInjectionMode(synax.injection),
    requiredCapabilities: asStringArray(synax['required-capabilities'] ?? synax.requiredCapabilities),
    permissionHints: asInternalGates(synax['permission-hints'] ?? synax.permissionHints),
    content: body.trim(),
    installPath,
  };
}
