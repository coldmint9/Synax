import { Hono } from 'hono';

export const healthRoutes = new Hono();

healthRoutes.get('/', async (c) => {
  return c.json({
    ok: true,
    service: 'api',
    ts: Date.now(),
  });
});
