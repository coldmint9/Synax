import { safeRelativePath } from './snapshot.js';
import { ArtifactError } from './contracts.js';
import { getArtifactBundle, getArtifactDependencies, getArtifactSource } from './store.js';
import { COMPILER_VERSION, POLICY_VERSION, SDK_VERSION } from './policy.js';

export interface ArtifactExport { content: string | Uint8Array; mediaType: string; filename: string }
function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
/** ZIP STORE: no shell, external archiver, path extraction, or extra runtime dependency. */
function zip(entries: Array<{ name: string; bytes: Uint8Array }>): Uint8Array {
  const local: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.name);
    const data = Buffer.from(entry.bytes);
    const checksum = crc32(data);
    const header = Buffer.alloc(30);
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6);
    header.writeUInt16LE(0x21, 12); header.writeUInt32LE(checksum, 14);
    header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26);
    local.push(header, name, data);
    const directory = Buffer.alloc(46);
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); directory.writeUInt16LE(20, 6); directory.writeUInt16LE(0x800, 8);
    directory.writeUInt16LE(0x21, 14); directory.writeUInt32LE(checksum, 16); directory.writeUInt32LE(data.length, 20); directory.writeUInt32LE(data.length, 24);
    directory.writeUInt16LE(name.length, 28); directory.writeUInt32LE(offset, 42); central.push(directory, name);
    offset += header.length + name.length + data.length;
  }
  const centralBytes = Buffer.concat(central);
  const end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}
export function exportArtifact(sessionId: string, revisionId: string, format: 'html' | 'source'): ArtifactExport {
  if (format !== 'html' && format !== 'source') throw new ArtifactError('INVALID_SOURCE', 'Unsupported artifact export format.');
  const { revision, html } = getArtifactBundle(sessionId, revisionId);
  const stem = revision.title.normalize('NFKD').replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80) || 'artifact';
  if (format === 'html') return { content: html, mediaType: 'text/html; charset=utf-8', filename: `${stem}-v${revision.revisionNumber}.html` };
  const source = getArtifactSource(sessionId, revisionId);
  const dependencies = getArtifactDependencies(sessionId, revisionId);
  // No owner/session/run IDs, absolute workspace paths, saved state, or credentials added.
  const manifest = { formatVersion: 1, title: revision.title, sourceKind: revision.sourceKind, entry: `source/${safeRelativePath(revision.sourcePath)}`, preview: 'preview.html', sourceHash: revision.sourceHash, bundleHash: revision.bundleHash, compilerVersion: COMPILER_VERSION, policyVersion: POLICY_VERSION, sdkVersion: SDK_VERSION, dependencies: dependencies.map(({ name, version, license }) => ({ name, version, license })) };
  const entries = source.map(file => ({ name: `source/${file.path}`, bytes: Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8') }));
  entries.push({ name: 'manifest.json', bytes: Buffer.from(JSON.stringify(manifest, null, 2)) }, { name: 'preview.html', bytes: Buffer.from(html) }, { name: 'LICENSES.txt', bytes: Buffer.from(dependencies.map(d => `${d.name} ${d.version} (${d.license})\n${d.licenseText}`).join('\n\n---\n\n')) }, { name: 'README.txt', bytes: Buffer.from('Open preview.html for the precompiled, offline artifact. No npm install or build scripts are required.\nLocal interactions use the SDK standalone fallback. Host feedback is available only inside Synax.\nSource files are untrusted user-generated code. The preview CSP restricts resources, but a standalone browser document is not an OS sandbox.\nSaved Synax private/model state is not included.\n') });
  return { content: zip(entries), mediaType: 'application/zip', filename: `${stem}-v${revision.revisionNumber}-source.zip` };
}
