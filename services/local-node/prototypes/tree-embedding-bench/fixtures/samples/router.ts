export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'DELETE';

export interface RouteHandler {
  method: HttpMethod;
  path: string;
  handler: (body: unknown) => Promise<unknown>;
}

export class Router {
  private routes: RouteHandler[] = [];

  register(method: HttpMethod, path: string, handler: RouteHandler['handler']): void {
    this.routes.push({ method, path, handler });
  }

  match(method: HttpMethod, path: string): RouteHandler | null {
    return this.routes.find((r) => r.method === method && r.path === path) ?? null;
  }

  async dispatch(method: HttpMethod, path: string, body: unknown): Promise<unknown> {
    const route = this.match(method, path);
    if (!route) throw new Error(`route not found: ${method} ${path}`);
    return route.handler(body);
  }
}

export function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

export function parseJsonBody<T>(raw: string): T {
  return JSON.parse(raw) as T;
}
