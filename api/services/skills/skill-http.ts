import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';

const FETCH_TIMEOUT_MS = 10_000;
const MAX_SKILL_BYTES = 256 * 1024;

const BLOCKED_HOSTNAMES = new Set([
  'localhost',
  'metadata.google.internal',
]);

function isPrivateIp(address: string): boolean {
  if (net.isIPv4(address)) {
    const parts = address.split('.').map(Number);
    if (parts[0] === 10) return true;
    if (parts[0] === 127) return true;
    if (parts[0] === 169 && parts[1] === 254) return true;
    if (parts[0] === 192 && parts[1] === 168) return true;
    if (parts[0] === 172 && parts[1]! >= 16 && parts[1]! <= 31) return true;
    return false;
  }
  if (net.isIPv6(address)) {
    const normalized = address.toLowerCase();
    if (normalized === '::1') return true;
    if (normalized.startsWith('fe80:')) return true;
    if (normalized.startsWith('fc') || normalized.startsWith('fd')) return true;
  }
  return false;
}

export async function assertSafeSkillUrl(rawUrl: string): Promise<URL> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new Error('Invalid skill URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('Skill URL must use http or https');
  }
  const hostname = url.hostname.toLowerCase();
  if (BLOCKED_HOSTNAMES.has(hostname) || hostname.endsWith('.local')) {
    throw new Error('Skill URL host is not allowed');
  }

  if (net.isIP(hostname)) {
    if (isPrivateIp(hostname)) throw new Error('Skill URL host is not allowed');
    return url;
  }

  const records = await dns.lookup(hostname, { all: true, verbatim: true });
  for (const record of records) {
    if (isPrivateIp(record.address)) {
      throw new Error('Skill URL resolves to a private address');
    }
  }
  return url;
}

export async function fetchSkillText(rawUrl: string, baseUrl?: string): Promise<string> {
  const resolved = new URL(rawUrl, baseUrl);
  await assertSafeSkillUrl(resolved.toString());

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(resolved.toString(), {
      headers: { Accept: 'text/markdown, text/plain, */*' },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch skill content (${response.status})`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.byteLength > MAX_SKILL_BYTES) {
      throw new Error('Skill content exceeds size limit');
    }
    return buffer.toString('utf8');
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchSkillJson<T>(rawUrl: string, baseUrl?: string): Promise<T> {
  const resolved = new URL(rawUrl, baseUrl);
  await assertSafeSkillUrl(resolved.toString());

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(resolved.toString(), {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`Failed to fetch skill index (${response.status})`);
    }
    return (await response.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

export function verifyContentDigest(content: string, digest?: string | null): boolean {
  if (!digest?.trim()) return true;
  const normalized = digest.trim().startsWith('sha256:') ? digest.trim().slice(7) : digest.trim();
  const actual = crypto.createHash('sha256').update(content).digest('hex');
  return actual === normalized;
}

export function sha256Digest(content: string): string {
  return crypto.createHash('sha256').update(content).digest('hex');
}
