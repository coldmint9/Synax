// ---------------------------------------------------------------------------
// api/routes/health.ts — 聚合健康检查
//
// 返回 Bun API 自身状态 + analyzer 本地依赖的可达性。
// ---------------------------------------------------------------------------

import { Hono } from 'hono';
import { analyzerHealth } from '../services/analyzer-client.js';

export const healthRoutes = new Hono();

healthRoutes.get('/', async (c) => {
  const analyzer = await analyzerHealth();
  return c.json({
    ok: true,
    service: 'api',
    deps: {
      analyzer,
    },
    ts: Date.now(),
  });
});
