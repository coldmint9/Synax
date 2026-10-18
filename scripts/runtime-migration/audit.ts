import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { V1Reader } from './v1-reader.js';

export async function auditV1(dataRoot: string, database: string, output: string) {
  const reader = new V1Reader(dataRoot, database);
  const sessions: Array<Record<string, unknown>> = [];
  const totals: Record<string, number> = {};
  const issues: Array<{ sessionId: string; reason: string }> = [];
  let assets = 0, assetBindings = 0;
  try {
    for (const session of reader.sessions()) {
      const tables: Record<string, { count: number; bytes: number; maxBytes: number; overFrame: number; digest: string }> = {};
      const hashes = new Map<string, ReturnType<typeof createHash>>();
      const sources: Record<string, number> = {};
      let checkpoints = 0;
      try {
        for (const { table, value, source } of reader.records(session)) {
          const encoded = JSON.stringify(value), bytes = Buffer.byteLength(encoded);
          const stat = tables[table] ??= { count: 0, bytes: 0, maxBytes: 0, overFrame: 0, digest: '' };
          stat.count++; stat.bytes += bytes; stat.maxBytes = Math.max(stat.maxBytes, bytes);
          if (bytes > 900 * 1024) stat.overFrame++;
          let digest = hashes.get(table);
          if (!digest) { digest = createHash('sha256'); hashes.set(table, digest); }
          digest.update(encoded).update('\n');
          sources[source] = (sources[source] ?? 0) + 1;
          totals[table] = (totals[table] ?? 0) + 1;
        }
        for (const _checkpoint of reader.checkpoints(session)) checkpoints++;
      } catch (error) {
        issues.push({ sessionId: session.id, reason: error instanceof Error ? error.message : String(error) });
      }
      for (const [table, digest] of hashes) tables[table].digest = digest.digest('hex');
      sessions.push({ sessionId: session.id, mode: session.mode, sources, checkpoints, tables });
      if (sessions.length % 25 === 0) console.error(JSON.stringify({ scannedSessions: sessions.length, issues: issues.length }));
    }
    for (const _asset of reader.assets()) assets++;
    for (const _binding of reader.assetBindings()) assetBindings++;
  } finally { reader.close(); }
  const result = { ok: issues.length === 0, scope: 'current visible records; checkpoint metadata; asset metadata (not file contents)',
    database, sessionCount: sessions.length, assets, assetBindings, totals, issues, sessions };
  await mkdir(path.dirname(output), { recursive: true });
  await writeFile(output, `${JSON.stringify(result, null, 2)}\n`);
  console.log(JSON.stringify({ command: 'audit-v1', output, sessions: sessions.length, assets, assetBindings, totals, issues, ok: result.ok }, null, 2));
  if (!result.ok) process.exitCode = 1;
}
