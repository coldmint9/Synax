import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { DATA_ROOT } from '../../lib/env.js';
import type { SerializationStrategy } from './contracts.js';

const CACHE_VERSION = 1;

export interface IndexCacheEntry {
  chunkId: string;
  textHash: string;
  vector: number[];
}

export interface IndexCacheFile {
  version: number;
  repoRoot: string;
  fingerprint: string;
  strategy: SerializationStrategy;
  chunkCount: number;
  dimensions: number;
  savedAt: number;
  entries: IndexCacheEntry[];
}

export function indexCacheDir(): string {
  return path.join(DATA_ROOT, 'tree-embedding-cache');
}

export function indexCachePath(
  fingerprint: string,
  strategy: SerializationStrategy,
): string {
  return path.join(indexCacheDir(), `${fingerprint}-${strategy}.json`);
}

export function hashEmbedText(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
}

export function loadIndexCache(
  fingerprint: string,
  strategy: SerializationStrategy,
  repoRoot: string,
): Map<string, IndexCacheEntry> | null {
  const filePath = indexCachePath(fingerprint, strategy);
  if (!fs.existsSync(filePath)) return null;
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8')) as IndexCacheFile;
    if (raw.version !== CACHE_VERSION) return null;
    if (raw.fingerprint !== fingerprint || raw.strategy !== strategy) return null;
    if (path.resolve(raw.repoRoot) !== path.resolve(repoRoot)) return null;
    return new Map(raw.entries.map((e) => [e.chunkId, e]));
  } catch {
    return null;
  }
}

export function saveIndexCache(
  fingerprint: string,
  strategy: SerializationStrategy,
  repoRoot: string,
  dimensions: number,
  entries: IndexCacheEntry[],
): void {
  const dir = indexCacheDir();
  fs.mkdirSync(dir, { recursive: true });
  const payload: IndexCacheFile = {
    version: CACHE_VERSION,
    repoRoot: path.resolve(repoRoot),
    fingerprint,
    strategy,
    chunkCount: entries.length,
    dimensions,
    savedAt: Date.now(),
    entries,
  };
  fs.writeFileSync(indexCachePath(fingerprint, strategy), JSON.stringify(payload));
}

export function summarizeCacheHit(
  total: number,
  cached: number,
): { embedded: number; reused: number } {
  return { embedded: total - cached, reused: cached };
}
