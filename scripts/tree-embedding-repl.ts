#!/usr/bin/env tsx
/**
 * 交互式自然语言 → Synax 代码 chunk retrieval CLI
 *
 * 语料：Synax 全库 tree-sitter 语法分析 chunk（默认）
 *
 *   npm run bench:repl
 *   npm run bench:repl -- --limit 200          # 开发时只索引前 200 chunk
 *   npm run bench:eval
 *   npm run bench:repl -- --fixture             # 小样本 fixture 模式
 */
import readline from 'node:readline/promises';
import path from 'node:path';
import { stdin as input, stdout as output } from 'node:process';

process.env.SYNAX_SCAN_IN_PROCESS ??= '1';

import type { SerializationStrategy } from '../api/prototypes/tree-embedding-bench/contracts.js';
import {
  formatCorpusStats,
  loadRepositoryCorpus,
  resolveRepoRoot,
} from '../api/prototypes/tree-embedding-bench/corpus-loader.js';
import {
  DEFAULT_EVAL_SET_PATH,
  loadEvalSetFile,
  resolveEvalSet,
  summarizeEvalSet,
  SYNAX_EVAL_SET_PATH,
  type EvalRunRow,
  type ResolvedEvalTask,
} from '../api/prototypes/tree-embedding-bench/eval-set.js';
import { loadFixtureIndex } from '../api/prototypes/tree-embedding-bench/fixtures.js';
import { mean } from '../api/prototypes/tree-embedding-bench/metrics.js';
import {
  CodeChunkRetrievalIndex,
  formatSearchHits,
} from '../api/prototypes/tree-embedding-bench/retrieval-index.js';
import {
  defaultChunkStrategy,
  listSerializationStrategies,
} from '../api/prototypes/tree-embedding-bench/serializers.js';

interface CliOptions {
  eval: boolean;
  fixture: boolean;
  strategy: SerializationStrategy;
  topK: number;
  baseUrl?: string;
  repoRoot: string;
  maxChunks?: number;
  noCache: boolean;
  evalSetPath: string;
}

function parseArgs(argv: string[]): CliOptions {
  let evalMode = false;
  let fixture = false;
  let strategy: SerializationStrategy = defaultChunkStrategy();
  let topK = 5;
  let baseUrl: string | undefined;
  let repoRoot = resolveRepoRoot();
  let maxChunks: number | undefined;
  let noCache = false;
  let evalSetPath = SYNAX_EVAL_SET_PATH;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--eval' || arg === '-e') evalMode = true;
    else if (arg === '--fixture') {
      fixture = true;
      evalSetPath = DEFAULT_EVAL_SET_PATH;
    } else if (arg === '--strategy' || arg === '-s') {
      strategy = argv[++i] as SerializationStrategy;
    } else if (arg === '--topk' || arg === '-k') {
      topK = Number(argv[++i]);
    } else if (arg === '--url' || arg === '-u') {
      baseUrl = argv[++i];
    } else if (arg === '--repo' || arg === '-r') {
      repoRoot = path.resolve(argv[++i]);
    } else if (arg === '--limit' || arg === '-l') {
      maxChunks = Number(argv[++i]);
    } else if (arg === '--no-cache') noCache = true;
    else if (arg === '--eval-set') evalSetPath = path.resolve(argv[++i]);
    else if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    }
  }

  return { eval: evalMode, fixture, strategy, topK, baseUrl, repoRoot, maxChunks, noCache, evalSetPath };
}

function printHelp(): void {
  console.log(`
Synax Code Chunk REPL — 自然语言召回语法分析 chunk

默认语料：Synax 全库（tree-sitter 符号级 chunk + 源码切片）

用法:
  npm run bench:repl -- [选项]

选项:
  --eval, -e              批量跑测评集后退出
  --fixture               使用小样本 fixture（快速调试）
  --repo, -r <path>       仓库根目录（默认 cwd）
  --limit, -l <n>         只索引前 N 个 chunk（开发用）
  --strategy, -s <name>   序列化策略（默认 chunk-enriched）
  --topk, -k <n>          展示 Top-N（默认 5）
  --no-cache              跳过 ~/.synax/tree-embedding-cache
  --eval-set <path>       测评集 JSON
  --url, -u <base>        embedding 服务地址

交互命令:
  <自然语言>              搜索
  eval [caseId]           跑测评集
  list / case <id>        查看测评 case
  strategy / topk         切换策略或 Top-N（strategy 会重建索引）
  show <name|chunkId>     查看 chunk embedding 文本
  stats                   索引统计
  quit                    退出
`);
}

async function buildIndexForCorpus(
  corpus: Awaited<ReturnType<typeof loadRepositoryCorpus>>,
  opts: Pick<CliOptions, 'strategy' | 'baseUrl' | 'noCache'>,
) {
  console.log(`\n构建 chunk 索引 (${opts.strategy})…`);
  let lastPct = -1;
  const { index, cache } = await CodeChunkRetrievalIndex.buildFromCorpus(corpus, {
    strategy: opts.strategy,
    baseUrl: opts.baseUrl,
    useCache: !opts.noCache,
    onProgress: (done, total, label) => {
      const pct = Math.floor((done / total) * 100);
      if (pct >= lastPct + 5 || done === total) {
        process.stdout.write(`\r  embedding ${done}/${total} (${pct}%) — ${label.slice(0, 36).padEnd(36)}`);
        lastPct = pct;
      }
    },
  });
  console.log(`\n  缓存: 复用 ${cache.reused}, 新 embed ${cache.embedded}`);
  return index;
}

async function runEvalBatch(
  index: CodeChunkRetrievalIndex,
  tasks: ResolvedEvalTask[],
  topK: number,
): Promise<EvalRunRow[]> {
  const rows: EvalRunRow[] = [];
  for (let i = 0; i < tasks.length; i += 1) {
    const task = tasks[i];
    process.stdout.write(`\r  测评 ${i + 1}/${tasks.length} — ${task.caseId} (${task.lang})`);
    const { hits, rankedIds } = await index.searchRanked(task.query, topK);
    const rank = index.symbolRankInResults(rankedIds, task.targetSymbolId);
    const targetHit = hits.find((h) => h.symbolIds.includes(task.targetSymbolId));
    const top = hits[0];
    rows.push({
      caseId: task.caseId,
      queryId: task.queryId,
      lang: task.lang,
      query: task.query,
      difficulty: task.difficulty,
      targetSymbol: task.target.symbol,
      targetFile: task.target.file,
      rank,
      topSymbol: top?.name ?? '',
      topFile: top?.filePath ?? '',
      similarity: targetHit?.similarity ?? 0,
      hitAt1: rank > 0 && rank <= 1,
      hitAt3: rank > 0 && rank <= 3,
      hitAt5: rank > 0 && rank <= 5,
    });
  }
  process.stdout.write('\n');
  return rows;
}

function printEvalSummary(rows: EvalRunRow[]): void {
  const r1 = mean(rows.map((r) => (r.hitAt1 ? 1 : 0)));
  const r3 = mean(rows.map((r) => (r.hitAt3 ? 1 : 0)));
  const r5 = mean(rows.map((r) => (r.hitAt5 ? 1 : 0)));
  const mrr = mean(rows.map((r) => (r.rank > 0 ? 1 / r.rank : 0)));

  console.log('\n── 测评汇总 ──');
  console.log(`  queries: ${rows.length}`);
  console.log(`  R@1: ${pct(r1)}  R@3: ${pct(r3)}  R@5: ${pct(r5)}  MRR: ${pct(mrr)}`);

  const misses = rows.filter((r) => !r.hitAt3);
  if (misses.length > 0) {
    console.log('\n── 未进 Top-3 ──');
    for (const m of misses.slice(0, 10)) {
      console.log(
        `  ${m.caseId} [${m.lang}] rank=${m.rank} expect=${m.targetFile}::${m.targetSymbol} → ${m.topFile}::${m.topSymbol}`,
      );
      console.log(`    Q: ${m.query}`);
    }
  }
}

function pct(v: number): string {
  return `${(v * 100).toFixed(1)}%`;
}

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));
  const strategies = listSerializationStrategies();
  if (!strategies.includes(opts.strategy)) {
    console.error(`未知策略: ${opts.strategy}\n可选: ${strategies.join(', ')}`);
    process.exit(1);
  }

  let corpus: Awaited<ReturnType<typeof loadRepositoryCorpus>>;
  if (opts.fixture) {
    const fixture = await loadFixtureIndex();
    const { buildChunkContexts } = await import('../api/prototypes/tree-embedding-bench/corpus-loader.js');
    const { parseOneFile } = await import('../api/services/analyzer/parse-lib.js');
    const fileText = new Map<string, string>();
    for (const f of fixture.codeIndex.files) {
      const abs = path.join(fixture.workDir, f.path);
      const parsed = await parseOneFile(abs, fixture.workDir);
      if (parsed) fileText.set(f.id, parsed.sourceFile.text);
    }
    corpus = {
      repoRoot: fixture.workDir,
      codeIndex: fixture.codeIndex,
      chunkContexts: buildChunkContexts(fixture.codeIndex, fileText),
      symbolContexts: fixture.contexts,
    };
  } else {
    console.log(`扫描仓库: ${opts.repoRoot}`);
    corpus = await loadRepositoryCorpus({
      repoRoot: opts.repoRoot,
      maxChunks: opts.maxChunks,
    });
  }

  const evalSet = loadEvalSetFile(opts.evalSetPath);
  const resolved = resolveEvalSet(evalSet, corpus.codeIndex);
  const summary = summarizeEvalSet(corpus.codeIndex, opts.evalSetPath);

  console.log('Synax Code Chunk REPL');
  console.log(`  语料: ${formatCorpusStats(corpus)}`);
  console.log(`  测评集: ${summary.resolvedCaseCount}/${summary.caseCount} cases, ${summary.queryCount} queries`);
  if (summary.unresolved.length > 0) {
    for (const u of summary.unresolved) {
      console.log(`  ⚠ 未解析: ${u.caseId} → ${u.target.file}::${u.target.symbol}`);
    }
  }

  let index = await buildIndexForCorpus(corpus, opts);
  console.log(`索引就绪: ${index.chunks.length} chunks, dim=${index.dimensions}, strategy=${index.strategy}`);

  if (opts.eval) {
    const rows = await runEvalBatch(index, resolved.tasks, Math.max(opts.topK, 5));
    printEvalSummary(rows);
    return;
  }

  const rl = readline.createInterface({ input, output, terminal: true });
  let topK = opts.topK;
  let strategy = opts.strategy;

  console.log('\n输入自然语言 query，或 help 查看命令。');

  const prompt = (): void => {
    rl.question('\n🔍 > ').then(handleLine).catch(() => rl.close());
  };

  const handleLine = async (line: string): Promise<void> => {
    const trimmed = line.trim();
    if (!trimmed) {
      prompt();
      return;
    }

    const [cmd, ...rest] = trimmed.split(/\s+/);
    const arg = rest.join(' ').trim();

    try {
      if (cmd === 'quit' || cmd === 'exit' || cmd === 'q') {
        rl.close();
        return;
      }
      if (cmd === 'help' || cmd === '?') {
        printHelp();
        prompt();
        return;
      }
      if (cmd === 'stats') {
        console.log(`  repo: ${index.repoRoot}`);
        console.log(`  chunks: ${index.chunks.length}, dim: ${index.dimensions}`);
        console.log(`  strategy: ${strategy}, topK: ${topK}, fingerprint: ${index.fingerprint}`);
        prompt();
        return;
      }
      if (cmd === 'list') {
        for (const c of resolved.cases) {
          console.log(`  ${c.id.padEnd(20)} ${c.target.file}::${c.target.symbol}`);
        }
        prompt();
        return;
      }
      if (cmd === 'case' && arg) {
        const c = resolved.cases.find((x) => x.id === arg);
        if (!c) console.log(`  未找到: ${arg}`);
        else {
          console.log(`  ${c.id} → ${c.target.file}::${c.target.symbol}`);
          c.queries.forEach((q, i) => console.log(`    ${i + 1}. [${q.lang}] ${q.text}`));
        }
        prompt();
        return;
      }
      if (cmd === 'strategy' && arg) {
        if (!strategies.includes(arg as SerializationStrategy)) {
          console.log(`  可选: ${strategies.join(', ')}`);
        } else {
          strategy = arg as SerializationStrategy;
          index = await buildIndexForCorpus(corpus, { ...opts, strategy });
          console.log(`\n已切换策略 → ${strategy}`);
        }
        prompt();
        return;
      }
      if (cmd === 'topk' && arg) {
        const n = Number(arg);
        if (Number.isFinite(n) && n > 0) topK = Math.floor(n);
        console.log(`  topK = ${topK}`);
        prompt();
        return;
      }
      if (cmd === 'show' && arg) {
        const chunk =
          index.findByChunkId(arg) ??
          index.findByName(arg) ??
          index.findByName(arg.split('::').pop() ?? arg, arg.includes('::') ? arg.split('::')[0] : undefined);
        if (!chunk) console.log(`  未找到: ${arg}`);
        else {
          console.log(`\n  ${chunk.filePath}:${chunk.startLine}-${chunk.endLine} (${chunk.chunkId})`);
          console.log(chunk.text.split('\n').map((l) => `  ${l}`).join('\n'));
        }
        prompt();
        return;
      }
      if (cmd === 'eval') {
        const tasks = arg ? resolved.tasks.filter((t) => t.caseId === arg) : resolved.tasks;
        if (tasks.length === 0) console.log('  无任务');
        else {
          const rows = await runEvalBatch(index, tasks, Math.max(topK, 5));
          printEvalSummary(rows);
        }
        prompt();
        return;
      }

      const t0 = Date.now();
      const hits = await index.search(trimmed, topK);
      console.log(`\n  (${Date.now() - t0}ms)`);
      const matched = resolved.tasks.find((t) => t.query === trimmed);
      console.log(formatSearchHits(hits, matched?.targetSymbolId));
      if (matched) {
        const { rank } = await index.rankForSymbol(trimmed, matched.targetSymbolId, index.chunks.length);
        console.log(`  [测评] ${matched.caseId} → rank ${rank > 0 ? rank : 'miss'}`);
      }
    } catch (err) {
      console.error(`  错误: ${err instanceof Error ? err.message : String(err)}`);
    }
    prompt();
  };

  rl.on('close', () => {
    console.log('\n再见。');
    process.exit(0);
  });

  prompt();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
