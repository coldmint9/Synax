// ---------------------------------------------------------------------------
// context-edge-smoke.ts — 边界 / 隔离 / 并发场景
//
// 覆盖：
//   - 无效 sessionId / entryId / memoryId 的 404 语义
//   - 超长 content / 超长 projectId 的 400 语义
//   - 并发 append：sequence 单调递增、无重复
//   - 并发不同 session 互不干扰
//   - 大批量 export / import（3000 条）
//   - 孤儿 entry（session 删除后 entries 被 CASCADE 清理）
//   - 触发器：delete session → FTS 同步清空
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';

const SMOKE_ROOT = path.resolve(process.cwd(), '.data/_smoke_edge');
if (fs.existsSync(SMOKE_ROOT)) fs.rmSync(SMOKE_ROOT, { recursive: true, force: true });
fs.mkdirSync(SMOKE_ROOT, { recursive: true });
process.env.DATA_ROOT = SMOKE_ROOT;
process.env.LOG_LEVEL = 'warn';

const { Hono } = await import('hono');
const { contextRoutes } = await import('../routes/context.js');
const { contextService } = await import('../services/context/context-service.js');
const { searchService } = await import('../services/context/search-service.js');
const { getRawSqlite } = await import('../db/index.js');

const app = new Hono();
app.route('/api/context', contextRoutes);

type Result = { name: string; ok: boolean; msg?: string };
const results: Result[] = [];
let passCount = 0, failCount = 0;
function check(name: string, cond: unknown, detail?: string) {
  const ok = Boolean(cond);
  results.push({ name, ok, msg: detail });
  if (ok) { passCount++; console.log(`  ✅ ${name}`); }
  else { failCount++; console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`); }
}
function section(t: string) { console.log(`\n▶ ${t}`); }

async function req<T = unknown>(
  method: string, url: string, body?: unknown,
): Promise<{ status: number; json: T | null }> {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await app.request(url, init);
  let json: T | null = null;
  try { json = (await res.clone().json()) as T; } catch { /* */ }
  return { status: res.status, json };
}

try {
  // ============================== 404 语义 ==============================
  section('未知资源 404');
  const ns = await req('GET', '/api/context/sessions/cs_nonexistent');
  check('GET /sessions/:id 不存在 → 404', ns.status === 404);

  const ne = await req('GET', '/api/context/entries/ce_nonexistent');
  check('GET /entries/:eid 不存在 → 404', ne.status === 404);

  const nm = await req('GET', '/api/context/memories/pm_nonexistent');
  check('GET /memories/:id 不存在 → 404', nm.status === 404);

  // ============================== 超长 content / projectId 400 ==============================
  section('输入校验 400');
  // 创建一个合法 session 先
  const sess = await req<{ id: string }>('POST', '/api/context/sessions',
    { projectId: 'proj_edge', userId: 'u1' });
  const sid = sess.json!.id;

  const longContent = 'x'.repeat(100_001);
  const longResp = await req('POST', `/api/context/sessions/${sid}/entries`,
    { role: 'user', content: longContent });
  check('content > 100k → 400', longResp.status === 400, `status=${longResp.status}`);

  const longProj = await req('POST', '/api/context/sessions',
    { projectId: 'p'.repeat(200), userId: 'u1' });
  check('projectId > 128 → 400', longProj.status === 400);

  const emptyContent = await req('POST', `/api/context/sessions/${sid}/entries`,
    { role: 'user', content: '' });
  check('空 content → 400', emptyContent.status === 400);

  // ============================== 并发 append sequence 单调递增 ==============================
  section('并发 append sequence 单调递增');
  const concurrentCount = 200;
  const beforeCount = contextService.getSession(sid)?.entryCount ?? 0;
  const tasks: Promise<any>[] = [];
  for (let i = 0; i < concurrentCount; i++) {
    tasks.push(Promise.resolve().then(() =>
      contextService.appendEntry(sid, { role: 'user', content: `concurrent-${i}` })));
  }
  const appended = await Promise.all(tasks);
  const seqs = appended.map((e: any) => e.sequence).sort((a: number, b: number) => a - b);
  const expectedSeqs = Array.from({ length: concurrentCount }, (_, i) => beforeCount + i);
  check('200 条并发 sequence 无重复',
    new Set(seqs).size === concurrentCount,
    `unique=${new Set(seqs).size}`);
  check('200 条并发 sequence 连续',
    JSON.stringify(seqs) === JSON.stringify(expectedSeqs),
    `first=${seqs[0]} last=${seqs[seqs.length - 1]}`);
  const afterSess = contextService.getSession(sid);
  check('session.entryCount 同步 +200', afterSess?.entryCount === beforeCount + concurrentCount,
    `got=${afterSess?.entryCount}`);

  // ============================== 不同 session 并发互不干扰 ==============================
  section('跨 session 并发隔离');
  const sA = contextService.createSession('proj_edge', 'uA').id;
  const sB = contextService.createSession('proj_edge', 'uB').id;
  await Promise.all([
    ...Array.from({ length: 50 }, (_, i) => Promise.resolve().then(() =>
      contextService.appendEntry(sA, { role: 'user', content: `A-${i}` }))),
    ...Array.from({ length: 50 }, (_, i) => Promise.resolve().then(() =>
      contextService.appendEntry(sB, { role: 'user', content: `B-${i}` }))),
  ]);
  const seA = contextService.getSession(sA)!;
  const seB = contextService.getSession(sB)!;
  check('session A entryCount=50', seA.entryCount === 50);
  check('session B entryCount=50', seB.entryCount === 50);

  // ============================== 大批量 export / import ==============================
  section('大批量 export / import (3000 条 entries)');
  const bigProj = 'proj_big';
  const bigSess = contextService.createSession(bigProj, 'bulk');
  const t0 = Date.now();
  for (let i = 0; i < 3000; i++) {
    contextService.appendEntry(bigSess.id,
      { role: 'user', content: `BULKKEY bulk item ${i}` });
  }
  const insertMs = Date.now() - t0;
  check('3000 条 append < 8s', insertMs < 8000, `${insertMs}ms`);

  const tE0 = Date.now();
  const bigExp = contextService.exportProject(bigProj);
  const exportMs = Date.now() - tE0;
  check('export 3000 条 < 1s', exportMs < 1000, `${exportMs}ms`);
  check('export 包含 3000 entries', bigExp.entries.length === 3000);

  const tI0 = Date.now();
  const impResult = contextService.importProject('proj_big_dst', bigExp, 'replace');
  const importMs = Date.now() - tI0;
  check('import 3000 条 < 3s', importMs < 3000, `${importMs}ms`);
  check('import 返回 entries=3000', impResult.entries === 3000, `got=${impResult.entries}`);

  const tS0 = Date.now();
  const bulkHits = searchService.searchEntries('proj_big_dst', 'BULKKEY', { limit: 50 });
  const searchMs = Date.now() - tS0;
  check('大批量 FTS 搜索 < 200ms', searchMs < 200, `${searchMs}ms`);
  check('FTS 返回 50 条', bulkHits.length === 50);

  // ============================== 级联删除 + FTS 同步 ==============================
  section('CASCADE delete 清理 FTS');
  const sqlite = getRawSqlite();
  const sessToDel = contextService.createSession('proj_cascade', 'u1').id;
  for (let i = 0; i < 5; i++) {
    contextService.appendEntry(sessToDel,
      { role: 'user', content: `CASCADEKEY ${i}` });
  }
  const beforeFts = (sqlite.prepare(
    "SELECT COUNT(*) AS n FROM context_fts WHERE context_fts MATCH 'CASCADEKEY'",
  ).get() as { n: number }).n;
  check('删除前 FTS 索引 5 条', beforeFts === 5, `got=${beforeFts}`);

  contextService.deleteSession(sessToDel);
  const afterFts = (sqlite.prepare(
    "SELECT COUNT(*) AS n FROM context_fts WHERE context_fts MATCH 'CASCADEKEY'",
  ).get() as { n: number }).n;
  check('删除 session 后 FTS 清空', afterFts === 0, `got=${afterFts}`);

  const entriesLeft = (sqlite.prepare(
    'SELECT COUNT(*) AS n FROM context_entries WHERE session_id = ?',
  ).get(sessToDel) as { n: number }).n;
  check('CASCADE 清理 entries 表', entriesLeft === 0);

  // ============================== 跨项目查询隔离 ==============================
  section('跨项目隔离回归');
  contextService.appendEntry(sA, { role: 'user', content: 'ISOKEY_in_A' });
  const isoA = searchService.searchEntries('proj_edge', 'ISOKEY_in_A');
  const isoOther = searchService.searchEntries('proj_big', 'ISOKEY_in_A');
  check('本项目 FTS 命中', isoA.length === 1);
  check('跨项目 FTS 不漏', isoOther.length === 0);

  // ============================== 空查询/特殊字符 ==============================
  section('FTS 特殊字符容错');
  // 带引号 / 特殊字符不应抛异常
  let sqlErr: string | null = null;
  try {
    searchService.searchEntries('proj_edge', '"quoted" AND (x OR y)');
  } catch (err) {
    sqlErr = String(err);
  }
  check('FTS 特殊查询不抛 500', sqlErr === null, sqlErr ?? undefined);
} catch (err) {
  failCount++;
  console.error('\n💥 edge smoke 抛出异常:', err);
  results.push({ name: 'unhandled exception', ok: false, msg: String(err) });
}

console.log('\n' + '='.repeat(60));
console.log(`EDGE SMOKE SUMMARY  pass=${passCount}  fail=${failCount}  total=${results.length}`);
if (failCount > 0) {
  console.log('\nFAILED:');
  for (const r of results.filter((r) => !r.ok)) {
    console.log(`  ✗ ${r.name}${r.msg ? ' — ' + r.msg : ''}`);
  }
}
console.log('='.repeat(60));
process.exit(failCount === 0 ? 0 : 1);
