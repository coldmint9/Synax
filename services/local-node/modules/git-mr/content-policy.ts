import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { GitMrError } from './errors.js';
import { git } from './repository.js';
import type { MergeRequest } from './contracts.js';

const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: true });
type XmlNode = Record<string, unknown>;
const object = (value: unknown): XmlNode | undefined => value && typeof value === 'object' && !Array.isArray(value) ? value as XmlNode : undefined;
const policyError = (message: string): never => { throw new GitMrError(message, 'BRANCH_POLICY'); };

/** Memoize substitutions per Maven profile. Bounded depth/output avoids both
 * repeated dependency × property walks and exponentially expanded properties. */
function resolver(properties: XmlNode, inherited: XmlNode, project: XmlNode) {
  const cache = new Map<string, string>(), visiting = new Set<string>();
  const expand = (raw: string, depth = 0): string => {
    if (depth > 64 || raw.length > 4096) return policyError('Dependency version properties exceed the validation budget.');
    let output = '', offset = 0;
    for (const match of raw.matchAll(/\$\{([^}]+)\}/g)) {
      output += raw.slice(offset, match.index) + property(match[1], depth + 1);
      if (output.length > 4096) return policyError('Dependency version properties exceed the validation budget.');
      offset = match.index! + match[0].length;
    }
    output += raw.slice(offset);
    if (output.length > 4096) return policyError('Dependency version properties exceed the validation budget.');
    return output;
  };
  const property = (name: string, depth: number): string => {
    const saved = cache.get(name);
    if (saved !== undefined) return saved;
    if (visiting.has(name)) return policyError('Cyclic dependency version property cannot be validated.');
    const raw = properties[name] ?? inherited[name] ?? (name === 'project.version' || name === 'pom.version' ? project.version : undefined);
    if (raw === undefined) return `\${${name}}`;
    if (typeof raw !== 'string' && typeof raw !== 'number') return policyError('Invalid dependency version property.');
    visiting.add(name);
    const value = expand(String(raw), depth);
    visiting.delete(name); cache.set(name, value);
    return value;
  };
  return expand;
}

function dependencyVersions(text: string): Map<string, string> {
  if (XMLValidator.validate(text) !== true) throw new GitMrError('Cannot validate dependency versions in malformed pom.xml.', 'BRANCH_POLICY');
  const document = parser.parse(text) as Record<string, unknown>;
  const project = document.project as Record<string, unknown> | undefined;
  const properties = object(project?.properties) ?? {};
  const versions = new Map<string, string>();
  const visit = (node: unknown, scope = 'project', expand = resolver(properties, {}, project ?? {})) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node)) { for (const [index, item] of node.entries()) visit(item, `${scope}/${index}`, expand); return; }
    for (const [key, value] of Object.entries(node)) {
      if (key === 'dependency') {
        for (const dependency of Array.isArray(value) ? value : [value]) {
          if (!dependency || typeof dependency !== 'object') continue;
          const item = dependency as Record<string, string>;
          const raw = String(item.version ?? '');
          const resolved = expand(raw);
          const identity = `${scope}:${item.groupId ?? ''}:${item.artifactId ?? ''}:${item.type ?? 'jar'}:${item.classifier ?? ''}`;
          if (versions.has(identity)) return policyError('Duplicate dependency identity cannot be validated safely.');
          versions.set(identity, `${raw}\0${resolved}`);
        }
      } else if (key === 'profile') {
        const seen = new Set<string>();
        for (const [index, valueProfile] of (Array.isArray(value) ? value : [value]).entries()) {
          const profile = object(valueProfile);
          if (!profile) continue;
          const id = String(profile.id ?? index);
          if (seen.has(id)) return policyError('Duplicate Maven profile cannot be validated safely.');
          seen.add(id);
          visit(profile, `${scope}/profile:${id}`, resolver(object(profile.properties) ?? {}, properties, project ?? {}));
        }
      } else if (key !== 'properties') visit(value, `${scope}/${key}`, expand);
    }
  };
  visit(project);
  return versions;
}

export function assertTestPomDependenciesUnchanged(before: string, after: string): void {
  const oldVersions = dependencyVersions(before), newVersions = dependencyVersions(after);
  for (const [key, version] of oldVersions) {
    if (newVersions.get(key) !== version)
      throw new GitMrError('Dependency versions in test pom.xml must remain unchanged.', 'BRANCH_POLICY');
  }
  for (const [key, version] of newVersions) {
    if (!oldVersions.has(key) && version.split('\0')[1] && !version.split('\0')[1].endsWith('-SNAPSHOT'))
      throw new GitMrError('New test pom.xml dependencies must use SNAPSHOT versions.', 'BRANCH_POLICY');
  }
}

/** Validate the staged candidate before creating a commit or publishing a branch. */
export async function assertMergeContentPolicy(mr: MergeRequest): Promise<void> {
  if (mr.target !== 'test' || !mr.worktree) return;
  const changed = (await git(mr, ['diff', '--cached', '--name-only', '-z', mr.targetOid, '--'], { cwd: mr.worktree })).stdout.split('\0').filter(file => file.split('/').at(-1) === 'pom.xml');
  for (const file of changed) {
    const original = await git(mr, ['show', `${mr.targetOid}:${file}`], { cwd: mr.worktree, allowFailure: true });
    const candidate = await git(mr, ['show', `:${file}`], { cwd: mr.worktree, allowFailure: true });
    if (original.status === 0 && candidate.status !== 0) throw new GitMrError('Deleting test pom.xml would remove dependency versions.', 'BRANCH_POLICY');
    if (candidate.status !== 0) continue;
    assertTestPomDependenciesUnchanged(original.status === 0 ? original.stdout : '<project/>', candidate.stdout);
  }
}
