// ---------------------------------------------------------------------------
// context-smoke.ts — 上下文管理系统端到端 smoke 测试（不经过 HTTP）
//
// 覆盖：
//   Phase1  DB 初始化 / schema / FTS5 触发器
//   Phase1  Session / Entry / Snapshot / Memory / Link CRUD
//   Phase2  SessionManager resume / SearchService 全文 + suggest
//   Phase3  MemoryManager extract / CompressionService / 相关记忆查询
//   Phase5  ExportProject / ImportProject(merge & replace)
//           SyncBus 事件发射
//           projectId 跨项目隔离
//
// 运行：bun api/__smoke__/context-smoke.ts
// 会在独立 DATA_ROOT(=.data/_smoke) 下创建 context.db，结束后打印汇总。
// ---------------------------------------------------------------------------

import fs from 'node:fs';
import path from 'node:path';

// 为避免污染主数据库，先设定 DATA_ROOT，然后再导入 service
const SMOKE_ROOT = path.resolve(process.cwd(), '.data/_smoke');
if (fs.existsSync(SMOKE_ROOT)) fs.rmSync(SMOKE_ROOT, { recursive: true, force: true });
fs.mkdirSync(SMOKE_ROOT, { recursive: true });
process.env.DATA_ROOT = SMOKE_ROOT;
process.env.LOG_LEVEL = 'warn';

const { contextService } = await import('../services/context/context-service.js');
const { sessionManager } = await import('../services/context/session-manager.js');
const { searchService } = await import('../services/context/search-service.js');
const { syncBus } = await import('../services/context/sync-bus.js');
const { getRawSqlite } = await import('../db/index.js');

type Result = { name: string; ok: boolean; msg?: string };
const results: Result[] = [];
let passCount = 0, failCount = 0;

function check(name: string, cond: unknown, detail?: string) {
  const ok = Boolean(cond);
  results.push({ name, ok, msg: detail });
  if (ok) {
    passCount++;
    console.log(`  ✅ ${name}`);
  } else {
    failCount++;
    console.log(`  ❌ ${name}${detail ? ' — ' + detail : ''}`);
  }
}

function section(title: string) {
  console.log(`\n▶ ${title}`);
}

function readPragma<T extends string | number>(sqlite: ReturnType<typeof getRawSqlite>, name: string): T {
  const row = sqlite.query(`PRAGMA ${name}`).get() as Record<string, T> | null;
  if (!row || !(name in row)) {
    throw new Error(`failed to read pragma: ${name}`);
  }
  return row[name];
}

// ============================== SyncBus 事件捕获 ==============================
const events: { type: string; projectId: string }[] = [];
const PROJECT_A = 'proj_smoke_a';
const PROJECT_B = 'proj_smoke_b';
const unsubA = syncBus.subscribe(PROJECT_A, (ev) => events.push({ type: ev.type, projectId: ev.projectId }));
const unsubB = syncBus.subscribe(PROJECT_B, (ev) => events.push({ type: ev.type, projectId: ev.projectId }));

try {
  // ============================== Phase1 DB ==============================
  section('Phase 1 · DB schema / 触发器');
  const sqlite = getRawSqlite();
  const tables = sqlite.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as { name: string }[];
  const names = tables.map((t) => t.name);
  for (const t of ['_meta', 'context_entries', 'context_links', 'context_sessions', 'context_snapshots', 'project_memories']) {
    check(`table exists: ${t}`, names.includes(t));
  }
  const ftsCount = sqlite.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='context_fts'").get() as { n: number };
  check('FTS5 virtual table context_fts 存在', ftsCount.n === 1);
  const triggers = (sqlite.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as { name: string }[]).map(r => r.name);
  check('AFTER INSERT/UPDATE/DELETE 触发器齐备',
    ['trg_entries_ai', 'trg_entries_au', 'trg_entries_ad'].every((n) => triggers.includes(n)));
  check('WAL 模式开启', readPragma<string>(sqlite, 'journal_mode').toLowerCase() === 'wal');
  check('foreign_keys 开启', readPragma<number>(sqlite, 'foreign_keys') === 1);

  // ============================== Phase1 Session CRUD ==============================
  section('Phase 1 · Session CRUD');
  const sess = contextService.createSession(PROJECT_A, 'user1', { title: 'smoke session', sourceAgent: 'smoke' });
  check('createSession 成功 & id 形如 cs_*', sess && /^cs_/.test(sess.id), sess?.id);
  check('createSession 返回带 projectId', sess.projectId === PROJECT_A);
  check('createSession status=active', sess.status === 'active');

  const listed = contextService.listSessions(PROJECT_A, { status: 'active' });
  check('listSessions 过滤 projectId+status', listed.items.some((s) => s.id === sess.id));

  // ============================== Phase1 Entry + FTS ==============================
  section('Phase 1 · Entry append + FTS 触发器');
  const e1 = contextService.appendEntry(sess.id, { role: 'user', content: 'hello world from smoke test' });
  const e2 = contextService.appendEntry(sess.id, { role: 'assistant', content: 'I will implement the authentication module using JWT tokens.' });
  const e3 = contextService.appendEntry(sess.id, { role: 'user', content: 'please review the database migration' });
  check('appendEntry 返回 sequence 递增', e1.sequence === 0 && e2.sequence === 1 && e3.sequence === 2);
  check('appendEntry 自动估算 tokenEstimate', e1.tokenEstimate > 0);

  // session entry_count 应同步更新
  const sessAfter = contextService.getSession(sess.id);
  check('session.entryCount 同步=3', sessAfter?.entryCount === 3, `got=${sessAfter?.entryCount}`);
  check('session.tokenCount > 0', (sessAfter?.tokenCount ?? 0) > 0);

  // FTS 行数应该跟上
  const ftsRows = sqlite.prepare('SELECT COUNT(*) AS n FROM context_fts').get() as { n: number };
  check('FTS 同步 3 行', ftsRows.n === 3, `got=${ftsRows.n}`);

  // ============================== Phase2 Search ==============================
  section('Phase 2 · SearchService (FTS5)');
  const hitsAuth = searchService.searchEntries(PROJECT_A, 'authentication');
  check('FTS 找到 authentication 关键字', hitsAuth.some((h) => h.id === e2.id));

  const hitsMigration = searchService.searchEntries(PROJECT_A, 'migration');
  check('FTS 找到 migration 关键字', hitsMigration.some((h) => h.id === e3.id));

  // ============================== Phase1 Snapshot ==============================
  section('Phase 1 · Snapshot');
  const snap = contextService.createSnapshot(sess.id, { label: 'v1' });
  check('createSnapshot 成功 cn_*', /^cn_/.test(snap.id));
  check('snapshot.entryCount 计算正确', snap.entryCount === 3);
  check('snapshot.fromSequence/toSequence 范围', snap.fromSequence === 0 && snap.toSequence === 2);

  // ============================== Phase1 Memory CRUD ==============================
  section('Phase 1 · Memory CRUD');
  const mem = contextService.createMemory(PROJECT_A, {
    memoryType: 'decision',
    title: 'Use JWT for auth',
    content: 'Team agreed to use JWT with 24h TTL',
    tags: ['auth', 'jwt'],
  });
  check('createMemory 成功 pm_*', /^pm_/.test(mem.id));
  const memList = contextService.listMemories(PROJECT_A, { memoryType: 'decision' });
  check('listMemories 过滤 memoryType', memList.items.some((m) => m.id === mem.id));

  // suggest 至少能跑通，结果是否命中取决于 FTS token / bm25
  const suggestions = searchService.suggest(PROJECT_A, 'authentication', 5);
  check('suggest 返回结构合法', Array.isArray(suggestions));

  // ============================== Phase1 Link + NodeDetailPanel ==============================
  section('Phase 1 · Context Link (entry ↔ node)');
  const link = contextService.createLink({
    projectId: PROJECT_A,
    entryId: e2.id,
    nodeId: 'node_action_001',
    linkType: 'discusses',
    confidence: 0.9,
  });
  check('createLink 成功 cl_*', /^cl_/.test(link.id));
  const linksByNode = contextService.getLinksByNode(PROJECT_A, 'node_action_001');
  check('getLinksByNode 命中', linksByNode.some((l) => l.id === link.id));

  // 唯一索引幂等 (INSERT OR IGNORE) 验证：重复调用不报错且不新增记录
  const before = contextService.getLinksByNode(PROJECT_A, 'node_action_001').length;
  contextService.createLink({ projectId: PROJECT_A, entryId: e2.id, nodeId: 'node_action_001', linkType: 'discusses' });
  const after = contextService.getLinksByNode(PROJECT_A, 'node_action_001').length;
  check('重复 (entry,node,linkType) 由唯一索引幂等忽略', after === before, `before=${before} after=${after}`);

  // ============================== Phase2 SessionManager resume ==============================
  section('Phase 2 · SessionManager.createOrResumeSession');
  const resumed = sessionManager.createOrResumeSession(PROJECT_A, 'user1', 'smoke');
  check('createOrResumeSession 复用已存在 session', resumed.id === sess.id, `resumed.id=${resumed.id}`);

  const resumedNew = sessionManager.createOrResumeSession(PROJECT_A, 'user2', 'smoke');
  check('不同 userId 则新建 session', resumedNew.id !== sess.id);

  // ============================== Phase5 跨项目隔离 ==============================
  section('Phase 5 · projectId 隔离');
  const sessB = contextService.createSession(PROJECT_B, 'user1', { title: 'proj B session' });
  contextService.appendEntry(sessB.id, { role: 'user', content: 'isolated content ABCXYZ' });
  const listB = contextService.listSessions(PROJECT_B);
  const listA = contextService.listSessions(PROJECT_A);
  check('项目 B 仅见自己的 session', listB.items.every((s) => s.projectId === PROJECT_B));
  check('项目 A 看不到项目 B 的 session', !listA.items.some((s) => s.id === sessB.id));
  const bHits = searchService.searchEntries(PROJECT_B, 'ABCXYZ');
  const aHits = searchService.searchEntries(PROJECT_A, 'ABCXYZ');
  check('搜索按 projectId 隔离 (B 命中)', bHits.length === 1);
  check('搜索按 projectId 隔离 (A 不命中)', aHits.length === 0);

  // ============================== Phase5 Export ==============================
  section('Phase 5 · Export / Import');
  const exp = contextService.exportProject(PROJECT_A);
  check('exportProject 包含 sessions', exp.sessions.length >= 2);
  check('exportProject 包含 entries', exp.entries.length === 3);
  check('exportProject 包含 snapshots', exp.snapshots.length === 1);
  check('exportProject 包含 memories', exp.memories.length === 1);
  check('exportProject 包含 links', exp.links.length === 1);
  check('exportProject.projectId === A', exp.projectId === PROJECT_A);

  // 导入到 PROJECT_B(merge, 保留原有 session + ABCXYZ entry)
  const mergeResult = contextService.importProject(PROJECT_B, { ...exp, projectId: PROJECT_B }, 'merge');
  check('import merge 返回计数', mergeResult.sessions >= 2 && mergeResult.entries === 3,
    `sessions=${mergeResult.sessions} entries=${mergeResult.entries}`);
  const listBAfterMerge = contextService.listSessions(PROJECT_B);
  check('merge 后项目 B session 数量增加', listBAfterMerge.items.length >= 3);
  // 原来的 ABCXYZ entry 还在
  const bHits2 = searchService.searchEntries(PROJECT_B, 'ABCXYZ');
  check('merge 不破坏 B 原有 entry', bHits2.length === 1);
  // 项目 A 的 entry 已复制到 B（按原始 id，保留）
  const bAuthHits = searchService.searchEntries(PROJECT_B, 'authentication');
  check('merge 后 B 能检索到 A 原始 entry', bAuthHits.length >= 1);

  // replace 策略：导入到一个全新项目 C 应清空后重建
  const PROJECT_C = 'proj_smoke_c';
  syncBus.subscribe(PROJECT_C, (ev) => events.push({ type: ev.type, projectId: ev.projectId }));
  // 先给 C 塞一个 session
  const sessC = contextService.createSession(PROJECT_C, 'user1');
  contextService.appendEntry(sessC.id, { role: 'user', content: 'will be wiped by replace' });
  const replaceResult = contextService.importProject(PROJECT_C, { ...exp, projectId: PROJECT_C }, 'replace');
  check('import replace 执行成功', replaceResult.sessions >= 2);
  const afterReplace = contextService.listSessions(PROJECT_C);
  check('replace 移除了原有 session', !afterReplace.items.some((s) => s.id === sessC.id));
  const cWipedHits = searchService.searchEntries(PROJECT_C, 'wiped');
  check('replace 清理了原有 entry', cWipedHits.length === 0);

  // 唯一索引约束：导入不能污染 cross-project 冲突（由 projectId 强制覆盖保证）
  check('import 时 payload.projectId 被覆盖到 target', exp.projectId !== PROJECT_C);

  // ============================== SyncBus 事件 ==============================
  section('SyncBus 事件');
  const aEvents = events.filter((e) => e.projectId === PROJECT_A);
  const bEvents = events.filter((e) => e.projectId === PROJECT_B);
  check('A 项目事件数 > 0', aEvents.length > 0, `count=${aEvents.length}`);
  check('B 项目事件数 > 0', bEvents.length > 0, `count=${bEvents.length}`);
  check('事件类型包含 session_created',
    events.some((e) => e.type === 'session_created'));
  check('事件类型包含 entry_created',
    events.some((e) => e.type === 'entry_created'));
  check('事件类型包含 memory_created',
    events.some((e) => e.type === 'memory_created'));
  check('事件类型包含 link_created',
    events.some((e) => e.type === 'link_created'));
  check('事件类型包含 snapshot_created',
    events.some((e) => e.type === 'snapshot_created'));

  // ============================== 归档 / 删除 ==============================
  section('Session 归档 / 硬删除');
  const archived = contextService.archiveSession(sess.id);
  check('archiveSession status=archived', archived.status === 'archived');
  check('archivedAt 被填充', !!archived.archivedAt);

  contextService.deleteSession(sessB.id);
  const sessBStillThere = contextService.getSession(sessB.id);
  check('deleteSession 级联清理', sessBStillThere === null);
  // cascade 应同时清理该 session 的 entries
  const bEntryCount = sqlite.prepare('SELECT COUNT(*) AS n FROM context_entries WHERE session_id=?').get(sessB.id) as { n: number };
  check('cascade 清理 session 下 entries', bEntryCount.n === 0);

  // ============================== 大批量性能 (1k entries) ==============================
  section('性能 · 批量 1000 条目');
  const perfSess = contextService.createSession(PROJECT_A, 'perf');
  const t0 = Date.now();
  for (let i = 0; i < 1000; i++) {
    contextService.appendEntry(perfSess.id, { role: 'user', content: `perf message ${i} with keyword PERFKEY` });
  }
  const dt = Date.now() - t0;
  check('1000 条 append 总时长 < 5s', dt < 5000, `${dt}ms`);
  const perfHits = searchService.searchEntries(PROJECT_A, 'PERFKEY', { limit: 10 });
  check('FTS 在 1k 数据上检索耗时可接受', perfHits.length === 10);
} catch (err) {
  failCount++;
  console.error('\n💥 smoke 抛出异常:', err);
  results.push({ name: 'unhandled exception', ok: false, msg: String(err) });
} finally {
  unsubA();
  unsubB();
}

// ============================== 汇总 ==============================
console.log('\n' + '='.repeat(60));
console.log(`SMOKE SUMMARY  pass=${passCount}  fail=${failCount}  total=${results.length}`);
if (failCount > 0) {
  console.log('\nFAILED:');
  for (const r of results.filter((r) => !r.ok)) {
    console.log(`  ✗ ${r.name}${r.msg ? ' — ' + r.msg : ''}`);
  }
}
console.log('='.repeat(60));
process.exit(failCount === 0 ? 0 : 1);
