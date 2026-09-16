import { EventEmitter } from "node:events";
import { vi } from "vitest";

export interface FakeResponseOptions {
  url: string;
  status?: number;
  body?: string;
  contentType?: string;
  method?: string;
  resourceType?: string;
}

export function fakeResponse(options: FakeResponseOptions) {
  const request = {
    method: () => options.method ?? "GET",
    resourceType: () => options.resourceType ?? "xhr",
  };
  return {
    url: () => options.url,
    status: () => options.status ?? 200,
    headers: () => ({ "content-type": options.contentType ?? "application/json" }),
    request: () => request,
    body: async () => Buffer.from(options.body ?? "{}"),
  };
}

export interface FakePageConfig {
  url?: string;
  title?: string;
  snapshot?: string;
  evaluateResult?: unknown;
}

/** Minimal Page stand-in covering everything browser-tools touches. */
export function fakePage(config: FakePageConfig = {}) {
  const emitter = new EventEmitter() as EventEmitter & Record<string, any>;
  const calls = { clicks: [] as any[], fills: [] as string[], presses: [] as string[], closed: false };
  const page = Object.assign(emitter, {
    _url: config.url ?? "about:blank",
    calls,
    url: () => page._url,
    isClosed: () => calls.closed,
    goto: async (url: string) => {
      page._url = url;
      return null;
    },
    title: async () => config.title ?? "Test Page",
    close: async () => {
      calls.closed = true;
    },
    evaluate: async () => config.evaluateResult ?? "evaluated",
    getByText: (_text: string) => ({
      first: () => ({ waitFor: async () => undefined }),
    }),
    waitForSelector: async (_selector: string) => ({}),
    screenshot: async (_options?: unknown) => Buffer.from("fake-jpeg-bytes"),
    locator: (selector: string) => {
      if (selector === "body")
        return {
          ariaSnapshot: async (_options?: unknown) =>
            config.snapshot ?? '- button "Save" [ref=e5]',
        };
      if (selector.startsWith("aria-ref=")) {
        const ref = selector.slice("aria-ref=".length);
        if (ref === "e999")
          return {
            click: async () => {
              throw new Error("Timeout 8000ms exceeded waiting for locator");
            },
            fill: async () => {
              throw new Error("Timeout 8000ms exceeded waiting for locator");
            },
            evaluate: async () => {
              throw new Error("no such element");
            },
            press: async () => {
              throw new Error("Timeout 8000ms exceeded waiting for locator");
            },
            screenshot: async () => Buffer.from("x"),
          };
        return {
          click: async (options?: unknown) => {
            calls.clicks.push({ ref, options });
          },
          fill: async (text: string) => {
            calls.fills.push(text);
          },
          press: async (key: string) => {
            calls.presses.push(key);
          },
          evaluate: async () => config.evaluateResult ?? "element-value",
          screenshot: async () => Buffer.from("fake-jpeg-bytes"),
        };
      }
      throw new Error(`Unexpected locator: ${selector}`);
    },
  });
  return page;
}

export interface FakeBrowserConfig {
  pages?: ReturnType<typeof fakePage>[];
}

/** Minimal Browser/Context stand-in: one context, preloaded pages. */
export function fakeBrowser(config: FakeBrowserConfig = {}) {
  const emitter = new EventEmitter() as EventEmitter & Record<string, any>;
  const context = Object.assign(new EventEmitter() as EventEmitter & Record<string, any>, {
    newPage: async () => {
      const page = fakePage();
      context.emit("page", page);
      return page;
    },
    close: async () => undefined,
  });
  for (const page of config.pages ?? []) context.emit("page", page);
  const browser = Object.assign(emitter, {
    contexts: () => [context],
    isConnected: () => true,
    newContext: vi.fn(async (_options?: unknown) => context),
    close: vi.fn(async () => undefined),
  });
  return { browser, context };
}
