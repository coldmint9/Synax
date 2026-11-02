/**
 * Compares the agent's current per-call ripgrep retrieval with an index-backed
 * path search, over real repositories.
 *
 * Usage:
 *   npx tsx scripts/workspace-search-bench.ts [--repo <path>]... [--iterations <n>]
 *     [--synthetic <files>] [--sidecar <path>] [--json]
 *
 * Two strategies are measured for the same agent intents:
 *   rg       - what tools/rg.ts does today: one short-lived ripgrep process per call.
 *   index    - an in-memory path index (the query layer a Rust workspace index
 *              would expose), plus the Rust sidecar's real page cache when
 *              --sidecar points at a built binary.
 * Content queries are measured only through rg: a path index cannot answer them.
 */
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { performance } from 'node:perf_hooks';
import fsp from 'node:fs/promises';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ignore from 'ignore';

const require = createRequire(import.meta.url);

interface Stats {
  n: number;
  p50: number;
  p95: number;
  min: number;
  max: number;
}
interface Row {
  id: string;
  strategy: 'rg' | 'index';
  hits: number;
  stats: Stats | null;
  note?: string;
}

function stats(values: number[]): Stats {
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
  return {
    n: sorted.length,
    p50: round(at(0.5)),
    p95: round(at(0.95)),
    min: round(sorted[0]),
    max: round(sorted[sorted.length - 1]),
  };
}
const round = (value: number) => Math.round(value * 100) / 100;

function resolveRipgrep(): string {
  const rgba = require('@vscode/ripgrep-universal') as {
    binPathFor?: (options: { os: string; arch: string }) => string;
    rgPath?: string;
  };
  const resolved = rgba.binPathFor
    ? rgba.binPathFor({ os: process.platform, arch: process.arch })
    : rgba.rgPath;
  if (!resolved) throw new Error('bundled ripgrep not found');
  return resolved;
}

/** One short-lived ripgrep process, exactly as the agent tool invokes it. */
function runRg(binary: string, args: string[], cwd: string): Promise<{ ms: number; out: string; code: number }> {
  return new Promise((resolve, reject) => {
    const started = performance.now();
    const child = spawn(binary, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      out += chunk;
    });
    child.stderr.resume();
    child.once('error', reject);
    child.once('close', (code) => resolve({ ms: performance.now() - started, out, code: code ?? 0 }));
  });
}

/** Iterates rg's own file list with its default ignore semantics: the ground
 * truth a path index has to reproduce for a fair per-query comparison. */
async function rgFiles(binary: string, cwd: string): Promise<string[]> {
  const result = await runRg(binary, ['--files'], cwd);
  return result.out.split(/\r?\n/).filter(Boolean).map((entry) => entry.split(path.sep).join('/'));
}

class PathIndex {
  readonly paths: string[];
  private readonly lower: string[];
  private readonly byName = new Map<string, string[]>();

  constructor(paths: string[]) {
    this.paths = paths;
    this.lower = paths.map((entry) => entry.toLowerCase());
    for (const entry of this.paths) {
      const name = entry.slice(entry.lastIndexOf('/') + 1).toLowerCase();
      const bucket = this.byName.get(name);
      if (bucket) bucket.push(entry);
      else this.byName.set(name, [entry]);
    }
  }

  byBasename(name: string): string[] {
    return this.byName.get(name.toLowerCase()) ?? [];
  }

  bySubstring(query: string): string[] {
    const needle = query.toLowerCase();
    const hits: string[] = [];
    for (let i = 0; i < this.lower.length; i++) if (this.lower[i].includes(needle)) hits.push(this.paths[i]);
    return hits;
  }

  byTokens(terms: string[]): string[] {
    const needles = terms.map((term) => term.toLowerCase()).filter(Boolean);
    const hits: string[] = [];
    for (let i = 0; i < this.lower.length; i++) {
      const entry = this.lower[i];
      if (needles.every((needle) => entry.includes(needle))) hits.push(this.paths[i]);
    }
    return hits;
  }

  byFuzzy(query: string): string[] {
    const needle = query.toLowerCase();
    const hits: string[] = [];
    for (let i = 0; i < this.lower.length; i++) {
      const name = this.lower[i].slice(this.lower[i].lastIndexOf('/') + 1);
      let cursor = 0;
      for (const character of name) {
        if (character === needle[cursor]) cursor++;
        if (cursor === needle.length) break;
      }
      if (cursor === needle.length) hits.push(this.paths[i]);
    }
    return hits;
  }

  byGlob(pattern: string): string[] {
    const matcher = ignore().add(pattern);
    const hits: string[] = [];
    for (let i = 0; i < this.paths.length; i++) if (matcher.ignores(this.paths[i])) hits.push(this.paths[i]);
    return hits;
  }
}

async function measure(
  id: string,
  strategy: Row['strategy'],
  iterations: number,
  run: () => Promise<{ hits: number; note?: string }> | { hits: number; note?: string },
): Promise<Row[]> {
  await run(); // warm-up: never report a cold JIT/page-cache artifact
  const durations: number[] = [];
  let last = { hits: 0, note: undefined as string | undefined };
  for (let i = 0; i < iterations; i++) {
    const started = performance.now();
    last = await run();
    durations.push(performance.now() - started);
  }
  return [{ id, strategy, hits: last.hits, stats: stats(durations), note: last.note }];
}

function deriveIntents(paths: string[]) {
  const extensions = new Map<string, number>();
  for (const entry of paths) {
    const name = entry.slice(entry.lastIndexOf('/') + 1);
    const dot = name.lastIndexOf('.');
    if (dot > 0) extensions.set(name.slice(dot), (extensions.get(name.slice(dot)) ?? 0) + 1);
  }
  const commonExtension = [...extensions.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? '.ts';
  const deepest = [...paths].sort((a, b) => b.split('/').length - a.split('/').length)[0] ?? 'index.ts';
  const basename = deepest.slice(deepest.lastIndexOf('/') + 1);
  const segments = deepest.split('/').slice(-3, -1);
  const stem = basename.slice(0, basename.lastIndexOf('.') > 0 ? basename.lastIndexOf('.') : basename.length);
  const abbreviation = stem
    .split(/[-_.]/)
    .map((part) => part.slice(0, 2))
    .join('')
    .slice(0, 6);
  return {
    basename,
    basenameGlob: `*${basename}`,
    token: stem.slice(0, Math.min(6, stem.length)).toLowerCase(),
    terms: segments.length ? segments : ['src'],
    fuzzy: abbreviation.toLowerCase(),
    glob: `**/*${commonExtension}`,
  };
}

async function benchRepo(label: string, root: string, iterations: number): Promise<Record<string, unknown>> {
  const binary = resolveRipgrep();
  const paths = await rgFiles(binary, root);
  const fileCount = paths.length;
  const intents = deriveIntents(paths);

  const buildStarted = performance.now();
  const index = new PathIndex(paths);
  const indexBuildMs = round(performance.now() - buildStarted);
  // Retained cost of a resident path set: string bytes plus per-entry overhead
  // for the array slot, the lowercase copy and the basename bucket.
  const pathBytes = paths.reduce((total, entry) => total + Buffer.byteLength(entry), 0);
  const indexBytes = pathBytes * 2 + paths.length * 96;

  const rows: Row[] = [];

  // Q1: find a file by exact name - the most common agent intent.
  rows.push(
    ...(await measure('q1-name-exact', 'rg', iterations, async () => {
      const result = await runRg(binary, ['--files', '--glob', intents.basenameGlob], root);
      return { hits: result.out.split(/\r?\n/).filter(Boolean).length };
    })),
    ...(await measure('q1-name-exact', 'index', 300, () => ({ hits: index.byBasename(intents.basename).length }))),
  );

  // Q2: substring of a name - no ripgrep glob can express this, so today's
  // fallback enumerates every file and filters in process.
  rows.push(
    ...(await measure('q2-name-substring', 'rg', iterations, async () => {
      const result = await runRg(binary, ['--files'], root);
      return { hits: result.out.split(/\r?\n/).filter((line) => line.toLowerCase().includes(intents.token)).length };
    })),
    ...(await measure('q2-name-substring', 'index', 300, () => ({ hits: index.bySubstring(intents.token).length }))),
  );

  // Q3: multi-term path narrowing ("agent runtime tools").
  rows.push(
    ...(await measure('q3-path-tokens', 'rg', iterations, async () => {
      const result = await runRg(binary, ['--files'], root);
      const needles = intents.terms.map((term) => term.toLowerCase());
      return {
        hits: result.out
          .split(/\r?\n/)
          .filter((line) => line && needles.every((needle) => line.toLowerCase().includes(needle))).length,
      };
    })),
    ...(await measure('q3-path-tokens', 'index', 300, () => ({ hits: index.byTokens(intents.terms).length }))),
  );

  // Q4: fuzzy abbreviation of a file name.
  rows.push(
    ...(await measure('q4-fuzzy-name', 'rg', iterations, async () => {
      const result = await runRg(binary, ['--files'], root);
      const needle = intents.fuzzy;
      return {
        hits: result.out.split(/\r?\n/).filter((line) => {
          if (!line) return false;
          const name = line.slice(line.lastIndexOf('/') + 1).toLowerCase();
          let cursor = 0;
          for (const character of name) {
            if (character === needle[cursor]) cursor++;
            if (cursor === needle.length) return true;
          }
          return needle.length === 0;
        }).length,
      };
    })),
    ...(await measure('q4-fuzzy-name', 'index', 300, () => ({ hits: index.byFuzzy(intents.fuzzy).length }))),
  );

  // Q5: extension glob listing.
  rows.push(
    ...(await measure('q5-ext-glob', 'rg', iterations, async () => {
      const result = await runRg(binary, ['--files', '--glob', intents.glob], root);
      return { hits: result.out.split(/\r?\n/).filter(Boolean).length };
    })),
    ...(await measure('q5-ext-glob', 'index', 100, () => ({ hits: index.byGlob(intents.glob).length }))),
  );

  // Q6/Q7: content search. A path index answers neither; ripgrep answers both.
  const contentTarget = 'workspaceIndexCommand';
  rows.push(
    ...(await measure('q6-content-literal', 'rg', iterations, async () => {
      const result = await runRg(binary, ['-n', '-F', '--max-count', '3', contentTarget], root);
      return { hits: result.out.split(/\r?\n/).filter(Boolean).length };
    })),
  );
  rows.push({
    id: 'q6-content-literal',
    strategy: 'index',
    hits: 0,
    stats: null,
    note: 'path-only index cannot answer content queries',
  });
  const wordTarget = 'resolveRipgrep';
  rows.push(
    ...(await measure('q7-content-word', 'rg', iterations, async () => {
      const result = await runRg(binary, ['-l', '-F', wordTarget], root);
      return { hits: result.out.split(/\r?\n/).filter(Boolean).length };
    })),
  );
  rows.push({ id: 'q7-content-word', strategy: 'index', hits: 0, stats: null, note: 'same boundary as q6' });

  // Full-text read pass: the unavoidable lower bound for any content index.
  const readStarted = performance.now();
  let bytes = 0;
  for (const relative of index.paths) {
    const stat = await fsp.stat(path.join(root, relative)).catch(() => null);
    if (!stat?.isFile() || stat.size > 2_000_000) continue;
    bytes += stat.size;
    await fsp.readFile(path.join(root, relative)).catch(() => undefined);
  }
  const fullReadMs = round(performance.now() - readStarted);

  // Staleness: how long until a new file becomes visible to each strategy.
  // The probe must be visible to rg's default rules, so it cannot be hidden.
  const probeName = `zz-bench-probe-${Date.now()}.ts`;
  const probePath = path.join(root, probeName);
  let watchEventMs: number | null = null;
  const created = performance.now();
  const watcher = fs.watch(root, { recursive: true }, (event, filename) => {
    if (watchEventMs === null && String(filename) === probeName) watchEventMs = round(performance.now() - created);
  });
  await fsp.writeFile(probePath, 'export {};\n');
  const afterWrite = performance.now();
  const rgSees = (await runRg(binary, ['--files', '--glob', probeName], root)).out.includes(probeName);
  const rgVisibleMs = round(performance.now() - afterWrite);
  await new Promise((resolve) => setTimeout(resolve, 300));
  watcher.close();
  const rebuildStarted = performance.now();
  const rebuilt = new PathIndex(await rgFiles(binary, root));
  const rebuildMs = round(performance.now() - rebuildStarted);
  const indexSees = rebuilt.byBasename(probeName).length > 0;
  await fsp.rm(probePath, { force: true });

  return {
    label,
    root,
    files: fileCount,
    intents,
    index: { buildMs: indexBuildMs, retainedBytes: indexBytes, bytesPerEntry: Math.round(indexBytes / Math.max(1, fileCount)) },
    fullText: { bytes, mb: round(bytes / 1024 / 1024), fullReadMs },
    staleness: { watchEventMs, rgVisibleMs, rgSawProbe: rgSees, rebuildMs, indexSawProbeAfterRebuild: indexSees },
    rows,
  };
}

interface SidecarResult {
  hostPath: string;
  buildMs: number;
  status: Record<string, number | boolean>;
  rssMb: number;
  listP50: number;
  listP95: number;
  staleMs: number | null;
  staleRetries?: number;
  capError?: string;
}

async function benchSidecar(binary: string, hostPath: string): Promise<SidecarResult> {
  const { RuntimeSidecarClient } = await import('../services/local-node/modules/agent-runtime/sidecar/sidecar-client.js');
  const { spawn: spawnSidecar } = await import('node:child_process');
  const { randomUUID } = await import('node:crypto');
  const temporary = await fsp.mkdtemp(path.join(os.tmpdir(), 'synax-index-bench-'));
  const socketPath = path.join(temporary, 'index.sock');
  const token = randomUUID();
  const child = spawnSidecar(binary, [], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: {
      ...process.env,
      SYNAX_RUNTIME_SIDECAR_SOCKET: socketPath,
      SYNAX_RUNTIME_SIDECAR_TOKEN: token,
      SYNAX_RUNTIME_SIDECAR_PORT: '0',
      SYNAX_RUNTIME_PROVIDER_PORT: '0',
      SYNAX_RUNTIME_PARENT_WATCH: '1',
      SYNAX_RUNTIME_STORE_PATH: path.join(temporary, 'store'),
      SYNAX_RUNTIME_HOT_PATH: path.join(temporary, 'hot'),
      SYNAX_RUNTIME_HISTORY_PATH: path.join(temporary, 'history'),
    },
  });
  child.stderr.resume();
  const client = new RuntimeSidecarClient({ socketPath, token, retryTimeoutMs: 10_000 });
  let staleRetries = 0;
  const query = async (operation: 'list' | 'register' | 'status', extra: Record<string, unknown> = {}) =>
    JSON.parse(Buffer.from(await client.workspaceIndexCommand(operation, { hostPath, ...extra })).toString('utf8'));
  // Cursors are revision-fenced: any concurrent change rejects the page. A
  // search tool must restart from the first page instead of trusting a cursor.
  const listRoot = async () => {
    for (;;) {
      try {
        return await query('list', { path: '', limit: 100 });
      } catch (error) {
        if ((error as { code?: string }).code !== 'INDEX_CURSOR_STALE' || staleRetries++ > 500) throw error;
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    }
  };
  try {
    await new Promise<void>((resolve, reject) => {
      let output = '';
      const timer = setTimeout(() => reject(new Error('sidecar startup timed out')), 20_000);
      child.once('error', reject);
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`sidecar exited: ${code}`));
      });
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk: string) => {
        output += chunk;
        if (output.includes('SYNAX_RUNTIME_READY:')) {
          clearTimeout(timer);
          resolve();
        }
      });
    });
    await client.connect();
    const registerStarted = performance.now();
    await query('register');
    let status = await query('status');
    let lastCached = -1;
    let stableSince = performance.now();
    let firstIdleMs: number | null = null;
    while (performance.now() - registerStarted < 60_000) {
      status = await query('status');
      const cached = Number(status.cachedDirectories ?? 0);
      if (!status.indexing && firstIdleMs === null && cached > 0) firstIdleMs = round(performance.now() - registerStarted);
      if (cached !== lastCached) {
        lastCached = cached;
        stableSince = performance.now();
      } else if (!status.indexing && performance.now() - stableSince > 250) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    // firstIdleMs is the observable build time; the settle window after it only
    // confirms that no further directories were queued.
    const buildMs = firstIdleMs ?? round(performance.now() - registerStarted);

    const listDurations: number[] = [];
    for (let i = 0; i < 100; i++) {
      const started = performance.now();
      await listRoot();
      listDurations.push(performance.now() - started);
    }
    const listStats = stats(listDurations);

    // Resident cost of the real Rust index, measured on the live process.
    const rssKb = await new Promise<number>((resolve) => {
      const ps = spawnSidecar('ps', ['-o', 'rss=', '-p', String(child.pid)]);
      let out = '';
      ps.stdout.setEncoding('utf8');
      ps.stdout.on('data', (chunk: string) => (out += chunk));
      ps.once('close', () => resolve(Number(out.trim()) || 0));
    });

    const revisionBefore = (await query('status')).revision;
    const probeName = `zz-bench-sidecar-${Date.now()}.ts`;
    await fsp.writeFile(path.join(hostPath, probeName), 'export {};\n');
    const started = performance.now();
    let visible = false;
    while (performance.now() - started < 8000) {
      const page = await listRoot();
      if ((page.entries as Array<{ name: string }>).some((item) => item.name === probeName)) {
        visible = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const staleMs = visible ? round(performance.now() - started) : null;
    await fsp.rm(path.join(hostPath, probeName), { force: true });
    return {
      hostPath,
      buildMs,
      status: status as Record<string, number | boolean>,
      rssMb: round(rssKb / 1024),
      listP50: listStats.p50,
      listP95: listStats.p95,
      staleMs: staleMs ?? null,
      staleRetries,
      capError: revisionBefore === undefined ? 'no revision reported' : undefined,
    };
  } finally {
    client.close();
    child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 300));
    if (child.exitCode === null) child.kill('SIGKILL');
    await fsp.rm(temporary, { recursive: true, force: true });
  }
}

async function syntheticTree(files: number): Promise<string> {
  const root = await fsp.mkdtemp(path.join(os.tmpdir(), 'synax-synth-'));
  const started = performance.now();
  for (let bucket = 0; bucket < Math.ceil(files / 500); bucket++) {
    const directory = path.join(root, `pkg${bucket}`, 'src');
    await fsp.mkdir(directory, { recursive: true });
    await Promise.all(
      Array.from({ length: Math.min(500, files - bucket * 500) }, (_, index) =>
        fsp.writeFile(path.join(directory, `module${index}-service.ts`), 'export const value = 1;\n'),
      ),
    );
  }
  console.log(`synthetic tree: ${files} files in ${Math.round(performance.now() - started)} ms at ${root}`);
  return root;
}

function printTable(report: Record<string, unknown>[]): void {
  console.log('');
  console.log('intent | strategy | p50 ms | p95 ms | hits | note');
  console.log('---|---|---|---|---|---');
  for (const repo of report) {
    for (const row of repo.rows as Row[]) {
      console.log(
        `${repo.label} ${row.id} | ${row.strategy} | ${row.stats?.p50 ?? 'n/a'} | ${row.stats?.p95 ?? 'n/a'} | ${row.hits} | ${row.note ?? ''}`,
      );
    }
  }
}

async function main(): Promise<void> {
  const argv = process.argv.slice(2);
  const repos: string[] = [];
  let iterations = 7;
  let synthetic = 0;
  let sidecar: string | null = null;
  let json = false;
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index];
    if (flag === '--repo') repos.push(path.resolve(argv[++index]));
    else if (flag === '--iterations') iterations = Number(argv[++index]);
    else if (flag === '--synthetic') synthetic = Number(argv[++index]);
    else if (flag === '--sidecar') sidecar = path.resolve(argv[++index]);
    else if (flag === '--json') json = true;
  }
  if (!repos.length) repos.push(process.cwd());

  const report: Record<string, unknown>[] = [];
  const scratch: string[] = [];
  for (const repo of repos) report.push(await benchRepo(path.basename(repo), repo, iterations));
  if (synthetic > 0) {
    const root = await syntheticTree(synthetic);
    scratch.push(root);
    report.push(await benchRepo(`synthetic-${synthetic}`, root, Math.max(3, Math.min(iterations, 5))));
  }
  const sidecarResults: SidecarResult[] = [];
  if (sidecar) {
    for (const repo of [...repos, ...scratch]) {
      try {
        sidecarResults.push(await benchSidecar(sidecar, repo));
      } catch (error) {
        sidecarResults.push({ hostPath: repo, capError: String(error) } as SidecarResult);
      }
    }
  }

  if (!json) printTable(report);
  const payload = { report, sidecar: sidecarResults };
  console.log('\n===BENCH_JSON===');
  console.log(JSON.stringify(payload, null, 2));
  for (const root of scratch) await fsp.rm(root, { recursive: true, force: true });
}

await main();
