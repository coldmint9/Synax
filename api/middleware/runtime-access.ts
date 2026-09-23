import fs from 'node:fs';
import path from 'node:path';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Hono, type Context } from 'hono';
import { cors } from 'hono/cors';
import { getCookie, setCookie } from 'hono/cookie';

const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);
function tokenAt(dataRoot: string): { token: string; tokenPath: string } {
  fs.mkdirSync(dataRoot, { recursive: true, mode: 0o700 });
  const tokenPath = path.join(dataRoot, 'runtime-access-token');
  try { fs.writeFileSync(tokenPath, `${randomBytes(32).toString('hex')}\n`, { flag: 'wx', mode: 0o600 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  if (!fs.lstatSync(tokenPath).isFile() || fs.lstatSync(tokenPath).isSymbolicLink()) throw new Error('Runtime token must be a regular file.');
  const token = fs.readFileSync(tokenPath, 'utf8').trim();
  if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid runtime token file; refusing to start an unauthenticated API.');
  fs.chmodSync(tokenPath, 0o600);
  return { token, tokenPath };
}

/** Single-user access control. Local browser bootstrap is distinct from explicit desktop/headless credentials. */
export function installRuntimeAccess(app: Hono, options: {
  dataRoot: string; webOrigins?: string[]; trustedHosts?: string[];
}): { tokenPath: string } {
  const { token, tokenPath } = tokenAt(options.dataRoot);
  const cookieName = `synax_runtime_${createHash('sha256').update(token).digest('hex').slice(0, 12)}`;
  const hosts = new Set([...LOOPBACK, ...(options.trustedHosts ?? [])]);
  const origins = new Set(options.webOrigins ?? ['http://localhost:5173', 'http://127.0.0.1:5173']);
  const matches = (value?: string) => Boolean(value && /^[a-f0-9]{64}$/.test(value) && timingSafeEqual(Buffer.from(value), Buffer.from(token)));
  const bearer = (c: Context) => matches(/^Bearer\s+([a-f0-9]{64})$/i.exec(c.req.header('Authorization') ?? '')?.[1]);
  const hostAllowed = (c: Context) => {
    try { return hosts.has(new URL(`http://${c.req.header('Host') ?? new URL(c.req.url).host}`).hostname); }
    catch { return false; }
  };
  const trustedOrigin = (origin: string | undefined, c: Context) => {
    if (!origin) return true;
    try { return origins.has(origin) || (origin === new URL(c.req.url).origin && hosts.has(new URL(origin).hostname)); }
    catch { return false; }
  };
  const desktopOrigin = (origin?: string) => origin === 'null' || origin === 'app://.' || origin === 'app://localhost';
  const browserBootstrap = (c: Context) => {
    const origin = c.req.header('Origin');
    if (!origin || !trustedOrigin(origin, c)) return false;
    try {
      return LOOPBACK.has(new URL(origin).hostname) && LOOPBACK.has(new URL(c.req.url).hostname)
        && ['same-origin', 'same-site'].includes(c.req.header('Sec-Fetch-Site') ?? '');
    } catch { return false; }
  };
  app.use('/api/*', async (c, next) => {
    if (!hostAllowed(c)) return c.json({ error: 'Untrusted runtime host.', code: 'HOST_DENIED' }, 403);
    if (c.req.method === 'GET' && c.req.path.replace(/\/$/, '') === '/api/health') return next();
    const origin = c.req.header('Origin');
    const explicit = bearer(c);
    const preflight = c.req.method === 'OPTIONS';
    if (!trustedOrigin(origin, c) && !(desktopOrigin(origin) && (explicit || preflight))) {
      return c.json({ error: 'Untrusted browser origin.', code: 'ORIGIN_DENIED' }, 403);
    }
    if (!preflight && !explicit && c.req.header('Sec-Fetch-Site') === 'cross-site') {
      return c.json({ error: 'Cross-site runtime access is denied.', code: 'ORIGIN_DENIED' }, 403);
    }
    if (preflight) return next();
    if (c.req.method === 'GET' && c.req.path.replace(/\/$/, '') === '/api/health') return next();
    const authenticated = explicit || (!desktopOrigin(origin) && matches(getCookie(c, cookieName)));
    if (!authenticated && !(c.req.method === 'POST' && c.req.path === '/api/auth/session' && browserBootstrap(c))) {
      return c.json({ error: 'Runtime authentication is required.', code: 'AUTH_REQUIRED' }, 401);
    }
    c.header('Cache-Control', 'no-store');
    return next();
  });
  app.use('/api/*', cors({
    origin: (origin, c) => trustedOrigin(origin, c) || desktopOrigin(origin) ? origin : undefined,
    credentials: true, allowHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'Last-Event-ID', 'Range', 'X-Synax-Artifact-Action'],
    exposeHeaders: ['Content-Disposition', 'Content-Length', 'Content-Range', 'Accept-Ranges'],
    allowMethods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
  }));
  app.post('/api/auth/session', c => {
    if (!desktopOrigin(c.req.header('Origin'))) setCookie(c, cookieName, token, {
      httpOnly: true, sameSite: 'Strict', secure: new URL(c.req.url).protocol === 'https:' || (Boolean(c.req.header('Origin')?.startsWith('https://')) && trustedOrigin(c.req.header('Origin'), c)), path: '/api', maxAge: 7 * 24 * 60 * 60,
    });
    return c.json({ authenticated: true });
  });
  return { tokenPath };
}
