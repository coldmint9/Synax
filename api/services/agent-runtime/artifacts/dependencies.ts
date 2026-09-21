import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { ArtifactError } from './contracts.js';
import { isPathWithin } from './paths.js';

export interface ArtifactDependency { name: string; version: string; license: string; licenseText: string }
interface PackageMetadata { name: string; version: string; license?: string; dependencies?: Record<string, string> }
interface InstalledPackage { root: string; entry: string; metadata: PackageMetadata; licenseText: string }
export const FIXED_D3_VERSION = '7.9.0';
const blocked = (message: string): never => { throw new ArtifactError('POLICY_BLOCKED', message, 503); };
function trustedFile(filename: string, modulesRoot: string): string {
  const real = fs.realpathSync(filename);
  if (!isPathWithin(modulesRoot, real) || !fs.statSync(real).isFile()) blocked('Compiler package resource is outside the trusted dependency tree.');
  return real;
}
/** Entry walking supports export maps that intentionally hide package.json (e.g. D3). */
export function resolveInstalledPackage(entry: string, name: string, modulesRoot: string, expectedVersion?: string): InstalledPackage {
  try {
    modulesRoot = fs.realpathSync(modulesRoot);
    const realEntry = trustedFile(entry, modulesRoot);
    let folder = path.dirname(realEntry);
    while (isPathWithin(modulesRoot, folder)) {
      const manifest = path.join(folder, 'package.json');
      if (fs.existsSync(manifest)) {
        const metadata = JSON.parse(fs.readFileSync(trustedFile(manifest, modulesRoot), 'utf8')) as PackageMetadata;
        // Intermediate dist/cjs package.json may only declare "type"; keep walking.
        if (metadata.name === name) {
          if (!metadata.version || expectedVersion && metadata.version !== expectedVersion) blocked(`Fixed dependency ${name} must be version ${expectedVersion}.`);
          const license = ['LICENSE', 'LICENSE.txt', 'LICENSE.md', 'LICENSE-MIT'].map(file => path.join(folder, file)).find(file => fs.existsSync(file));
          const licenseText = license ? fs.readFileSync(trustedFile(license, modulesRoot), 'utf8') : `License declared by ${name}: ${metadata.license ?? 'not specified'}.`;
          return { root: folder, entry: realEntry, metadata, licenseText };
        }
      }
      folder = path.dirname(folder);
    }
    return blocked(`Cannot locate trusted package metadata for ${name}.`);
  } catch (error) {
    if (error instanceof ArtifactError) throw error;
    return blocked(`Required fixed dependency is unavailable or invalid: ${name}.`);
  }
}
export function installedDependencies(hostRequire: NodeRequire): { entries: Record<string, string>; licenses: ArtifactDependency[]; packageRoots: string[]; modulesRoot: string; esbuildPath: string; parse5Path: string } {
  const esbuildEntry = hostRequire.resolve('esbuild');
  let modulesRoot = path.dirname(esbuildEntry);
  while (path.basename(modulesRoot) !== 'node_modules') {
    const parent = path.dirname(modulesRoot);
    if (parent === modulesRoot) return blocked('The packaged compiler dependencies are unavailable.');
    modulesRoot = parent;
  }
  modulesRoot = fs.realpathSync(modulesRoot);
  const esbuildPath = trustedFile(esbuildEntry, modulesRoot);
  const parse5Path = trustedFile(hostRequire.resolve('parse5'), modulesRoot);
  const entries: Record<string, string> = Object.create(null);
  const packages = new Map<string, InstalledPackage>();
  function collect(name: string, resolver: NodeRequire, expectedVersion?: string): InstalledPackage {
    let entry: string;
    try { entry = resolver.resolve(name); } catch { return blocked(`Required fixed dependency is unavailable: ${name}.`); }
    const pkg = resolveInstalledPackage(entry, name, modulesRoot, expectedVersion);
    if (packages.has(pkg.root)) return packages.get(pkg.root)!;
    if (packages.size >= 200) return blocked('Fixed dependency graph exceeds its package count limit.');
    packages.set(pkg.root, pkg);
    const childRequire = createRequire(pkg.entry);
    for (const dependency of Object.keys(pkg.metadata.dependencies ?? {}).sort()) collect(dependency, childRequire);
    return pkg;
  }
  for (const name of ['react', 'react-dom', 'lucide-react', 'd3']) {
    collect(name, hostRequire, name === 'd3' ? FIXED_D3_VERSION : undefined);
    const allowedEntries = name === 'react' ? ['react','react/jsx-runtime','react/jsx-dev-runtime'] : name === 'react-dom' ? ['react-dom','react-dom/client'] : [name];
    for (const entry of allowedEntries) entries[entry] = trustedFile(hostRequire.resolve(entry), modulesRoot);
  }
  const licenses = [...packages.values()].map(pkg => ({ name: pkg.metadata.name, version: pkg.metadata.version, license: pkg.metadata.license ?? 'not specified', licenseText: pkg.licenseText }))
    .sort((a, b) => a.name.localeCompare(b.name, 'en') || a.version.localeCompare(b.version, 'en'));
  return { entries, licenses, packageRoots: [...packages.keys()], modulesRoot, esbuildPath, parse5Path };
}
