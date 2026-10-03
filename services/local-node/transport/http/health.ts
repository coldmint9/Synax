import { Hono } from 'hono';

export const healthRoutes = new Hono();

healthRoutes.get('/', async (c) => {
  return c.json({
    ok: true,
    service: 'api',
    capabilities: { realtime: 1 },
    ts: Date.now(),
  });
});
