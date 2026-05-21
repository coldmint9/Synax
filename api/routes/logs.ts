import { Hono } from 'hono';
import * as z from 'zod/v4';
import { listApiLogDailyStats, listApiLogs } from '../lib/log-store.js';

export const logRoutes = new Hono();

const statsQuerySchema = z.object({
  days: z.coerce.number().int().min(1).max(365).optional().default(30),
});

const listQuerySchema = z.object({
  day: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  limit: z.coerce.number().int().min(1).max(500).optional().default(100),
});

logRoutes.get('/stats/daily', (c) => {
  const parsed = statsQuerySchema.safeParse({
    days: c.req.query('days') ?? '30',
  });
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  return c.json({
    items: listApiLogDailyStats(parsed.data.days),
  });
});

logRoutes.get('/', (c) => {
  const parsed = listQuerySchema.safeParse({
    day: c.req.query('day') ?? undefined,
    limit: c.req.query('limit') ?? '100',
  });
  if (!parsed.success) {
    return c.json({ error: 'Validation failed', details: parsed.error.flatten() }, 400);
  }

  return c.json({
    items: listApiLogs(parsed.data),
  });
});
