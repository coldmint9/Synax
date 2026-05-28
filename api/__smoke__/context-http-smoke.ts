import fs from 'node:fs';
import path from 'node:path';

const SMOKE_ROOT = path.resolve(process.cwd(), '.data/_smoke_http');
if (fs.existsSync(SMOKE_ROOT)) fs.rmSync(SMOKE_ROOT, { recursive: true, force: true });
fs.mkdirSync(SMOKE_ROOT, { recursive: true });
process.env.DATA_ROOT = SMOKE_ROOT;
process.env.LOG_LEVEL = 'warn';

const { Hono } = await import('hono');
const { contextRoutes } = await import('../routes/context.js');

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
): Promise<{ status: number; json: T | null; raw: Response }> {
  const init: RequestInit = { method, headers: { 'content-type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const res = await app.request(url, init);
  let json: T | null = null;
  try { json = (await res.clone().json()) as T; } catch { /* ignore */ }
  return { status: res.status, json, raw: res };
}

const PROJ = 'proj_http_smoke';

try {
  // ============================== Zod 校验 ==============================
  section('路由层 Zod 校验');
  const bad1 = await req('POST', '/api/context/sessions', { userId: 'u1' });
  check('POST /sessions 缺 projectId → 400', bad1.status === 400);

  const bad2 = await req('GET', '/api/context/sessions');
  check('GET /sessions 缺 projectId → 400', bad2.status === 400);

  // ============================== Session CRUD ==============================
  section('Session CRUD');
  const r1 = await req<{ id: string; projectId: string; status: string }>(
    'POST', '/api/context/sessions', { projectId: PROJ, userId: 'u1', title: 'http smoke' },
  );
  check('POST /sessions → 2xx', r1.status === 200 || r1.status === 201, `status=${r1.status}`);
  check('返回 session 带 cs_ 前缀', r1.json && /^cs_/.test(r1.json.id));
  const sessionId = r1.json!.id;

  const r2 = await req(`GET`, `/api/context/sessions?projectId=${PROJ}`);
  check('GET /sessions 返回列表', r2.status === 200 && Array.isArray((r2.json as any)?.items));
  check('列表命中刚创建的 session',
    Array.isArray((r2.json as any)?.items) && (r2.json as any).items.some((s: any) => s.id === sessionId));

  // ============================== Entry append ==============================
  section('Entry append');
  const e1 = await req(`POST`, `/api/context/sessions/${sessionId}/entries`,
    { role: 'user', content: 'search for AUTHMAGIC keyword' });
  check('POST /sessions/:id/entries → 2xx', e1.status === 200 || e1.status === 201);
  check('entry.sequence=0', (e1.json as any)?.sequence === 0);
  const entryId = (e1.json as any).id;

  const e2 = await req(`POST`, `/api/context/sessions/${sessionId}/entries`,
    { role: 'assistant', content: 'I will implement AUTHMAGIC with JWT tokens' });
  check('第二条 entry.sequence=1', (e2.json as any)?.sequence === 1);

  // role 非法 → 400
  const eBad = await req(`POST`, `/api/context/sessions/${sessionId}/entries`,
    { role: 'bogus', content: 'x' });
  check('非法 role → 400', eBad.status === 400);

  // ============================== Search ==============================
  section('Search /context/search');
  const s1 = await req(`POST`, `/api/context/search`,
    { projectId: PROJ, query: 'AUTHMAGIC', scope: 'entries' });
  check('POST /search 200', s1.status === 200, `status=${s1.status}`);
  check('search 命中 2 条', Array.isArray((s1.json as any)?.items) && (s1.json as any).items.length === 2,
    `got=${(s1.json as any)?.items?.length}`);

  // ============================== Snapshot ==============================
  section('Snapshot');
  const sn1 = await req('POST', `/api/context/sessions/${sessionId}/snapshots`, { label: 'http-v1' });
  check('POST /sessions/:id/snapshots → 2xx', sn1.status === 200 || sn1.status === 201);
  check('snapshot id 带 cn_', /^cn_/.test((sn1.json as any)?.id ?? ''));
  const snGet = await req('GET', `/api/context/sessions/${sessionId}/snapshots`);
  check('GET snapshots 返回列表', Array.isArray((snGet.json as any)?.items ?? (snGet.json as any)));

  // ============================== Memory ==============================
  section('Memory');
  const m1 = await req('POST', '/api/context/memories',
    { projectId: PROJ, memoryType: 'decision', title: 'Use JWT', content: 'JWT with 24h TTL', tags: ['auth'] });
  check('POST /memories → 2xx', m1.status === 200 || m1.status === 201);
  const memoryId = (m1.json as any)?.id;
  check('memory id 带 pm_', /^pm_/.test(memoryId ?? ''));
  const mL = await req('GET', `/api/context/memories?projectId=${PROJ}`);
  check('GET /memories 列表命中', Array.isArray((mL.json as any)?.items) &&
    (mL.json as any).items.some((m: any) => m.id === memoryId));

  // ============================== Link + NodeDetailPanel ==============================
  section('Context Link');
  const l1 = await req('POST', '/api/context/links',
    { projectId: PROJ, entryId, nodeId: 'node_http_001', linkType: 'discusses', confidence: 0.8 });
  check('POST /links → 2xx', l1.status === 200 || l1.status === 201);

  const lNode = await req('GET', `/api/context/links?projectId=${PROJ}&nodeId=node_http_001`);
  check('GET /links?projectId=&nodeId= 命中',
    Array.isArray((lNode.json as any)?.items) &&
    (lNode.json as any).items.some((l: any) => l.entryId === entryId),
    `resp=${JSON.stringify(lNode.json)}`);

  // NodeDetailPanel 需要的轻量 getEntry
  const entryGet = await req('GET', `/api/context/entries/${entryId}`);
  check('GET /entries/:eid → 200', entryGet.status === 200);
  check('entries/:eid 返回 id/content', (entryGet.json as any)?.id === entryId);

  // ============================== SSE /sync ==============================
  section('SSE /sync 实时推送');
  // 异步在一段时间内收 SSE 事件
  const ac = new AbortController();
  const received: { type: string; projectId?: string }[] = [];
  const ssePromise = (async () => {
    const res = await app.request(`/api/context/sync?projectId=${PROJ}`, { signal: ac.signal });
    check('SSE content-type 为 text/event-stream', res.headers.get('content-type')?.includes('text/event-stream') === true,
      `got=${res.headers.get('content-type')}`);
    const reader = res.body?.getReader();
    if (!reader) return;
    const dec = new TextDecoder();
    let buf = '';
    const start = Date.now();
    while (Date.now() - start < 1500) {
      const { value, done } = await Promise.race([
        reader.read(),
        new Promise<{ value: undefined; done: true }>((r) => setTimeout(() => r({ value: undefined, done: true }), 1200)),
      ]);
      if (done || !value) break;
      buf += dec.decode(value, { stream: true });
      const frames = buf.split('\n\n');
      buf = frames.pop() ?? '';
      for (const frame of frames) {
        const evMatch = frame.match(/event:\s*(\S+)/);
        const dataMatch = frame.match(/data:\s*(.+)/);
        if (evMatch && evMatch[1] !== 'hello' && evMatch[1] !== 'ping' && evMatch[1] !== 'ready') {
          let parsed: any = null;
          try { parsed = dataMatch ? JSON.parse(dataMatch[1]) : null; } catch { /* */ }
          received.push({ type: evMatch[1], projectId: parsed?.projectId });
        }
      }
    }
    try { await reader.cancel(); } catch { /* */ }
  })();

  // 等 SSE 连接建立后产生事件
  await new Promise((r) => setTimeout(r, 150));
  await req('POST', '/api/context/sessions', { projectId: PROJ, userId: 'u2' });
  await new Promise((r) => setTimeout(r, 100));
  await req('POST', `/api/context/sessions/${sessionId}/entries`,
    { role: 'user', content: 'trigger sse event' });
  await ssePromise;
  ac.abort();

  check('SSE 收到 session_created',
    received.some((e) => e.type === 'session_created'), `received=${JSON.stringify(received)}`);
  check('SSE 收到 entry_created',
    received.some((e) => e.type === 'entry_created'));
  check('SSE 事件都属于 target project',
    received.every((e) => !e.projectId || e.projectId === PROJ));

  // ============================== Export / Import ==============================
  section('Export / Import');
  const exp = await req(`POST`, `/api/context/export`, { projectId: PROJ });
  check('POST /export → 200', exp.status === 200);
  check('exp.sessions 非空', ((exp.json as any)?.sessions?.length ?? 0) >= 2);

  const PROJ2 = 'proj_http_smoke_dst';
  const imp1 = await req('POST', `/api/context/import`,
    { projectId: PROJ2, strategy: 'merge', data: exp.json });
  check('POST /import merge → 200', imp1.status === 200, `status=${imp1.status} body=${JSON.stringify(imp1.json)}`);
  check('import result.sessions > 0', ((imp1.json as any)?.result?.sessions ?? 0) > 0,
    `got=${JSON.stringify(imp1.json)}`);

  const listDst = await req(`GET`, `/api/context/sessions?projectId=${PROJ2}`);
  check('目标项目能看到 merge 进来的 session',
    ((listDst.json as any)?.items?.length ?? 0) >= 2);

  // ============================== 非法 projectId 隔离 ==============================
  section('projectId 隔离');
  const strangeProj = 'proj_nonexistent';
  const e0 = await req(`GET`, `/api/context/sessions?projectId=${strangeProj}`);
  check('未知 projectId 返回空列表', (e0.json as any)?.items?.length === 0);
  const search0 = await req(`POST`, `/api/context/search`,
    { projectId: strangeProj, query: 'AUTHMAGIC', scope: 'entries' });
  check('未知 projectId 搜索结果为空', ((search0.json as any)?.items?.length ?? 0) === 0);

} catch (err) {
  failCount++;
  console.error('\n💥 http smoke 抛出异常:', err);
  results.push({ name: 'unhandled exception', ok: false, msg: String(err) });
}

console.log('\n' + '='.repeat(60));
console.log(`HTTP SMOKE SUMMARY  pass=${passCount}  fail=${failCount}  total=${results.length}`);
if (failCount > 0) {
  console.log('\nFAILED:');
  for (const r of results.filter((r) => !r.ok)) {
    console.log(`  ✗ ${r.name}${r.msg ? ' — ' + r.msg : ''}`);
  }
}
console.log('='.repeat(60));
process.exit(failCount === 0 ? 0 : 1);
