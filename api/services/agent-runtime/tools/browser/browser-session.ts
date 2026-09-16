import {
  type Browser,
  type BrowserContext,
  type Page,
  type Response,
} from "playwright-core";
import { launchWithFallback } from "./browser-launch.js";

export interface ConsoleEntry {
  seq: number;
  level: string;
  text: string;
  url: string | null;
  at: string;
}

export interface NetworkEntry {
  seq: number;
  method: string;
  url: string;
  status: number | null;
  resourceType: string;
  contentType: string | null;
  error: string | null;
  at: string;
  /** Kept so a later `browser.network { seq }` can still read the body. */
  response: Response | null;
}

/** Fixed-cap FIFO; the browser can produce unbounded traffic, so drop oldest. */
export class RingBuffer<T> {
  readonly items: T[] = [];
  constructor(readonly capacity: number) {}
  push(value: T): void {
    this.items.push(value);
    if (this.items.length > this.capacity) this.items.splice(0, this.items.length - this.capacity);
  }
  get length(): number {
    return this.items.length;
  }
}

const CONSOLE_BUFFER_CAP = 600;
const NETWORK_BUFFER_CAP = 400;
const NAVIGATION_TIMEOUT_MS = 30_000;

export type BrowserLauncher = typeof launchWithFallback;

export interface BrowserSessionConfig {
  sessionId: string;
  headless?: boolean;
  launcher?: BrowserLauncher;
}

interface PageMeta {
  seq: number;
  page: Page;
}

function timestamp(): string {
  return new Date().toISOString();
}

export class BrowserSession {
  private readonly pages = new Map<number, PageMeta>();
  private browser: Browser | null = null;
  private context: BrowserContext | null = null;
  private nextPageSeq = 1;
  private nextConsoleSeq = 1;
  private nextNetworkSeq = 1;
  private activePageSeq: number | null = null;
  private disposing: Promise<void> | null = null;
  private isDisposed = false;

  readonly consoleBuffer = new RingBuffer<ConsoleEntry>(CONSOLE_BUFFER_CAP);
  readonly networkBuffer = new RingBuffer<NetworkEntry>(NETWORK_BUFFER_CAP);
  launchSource: string | null = null;
  lastUsedAt = Date.now();

  constructor(private readonly config: BrowserSessionConfig) {}

  get disposed(): boolean {
    return this.isDisposed;
  }

  get idleMs(): number {
    return Date.now() - this.lastUsedAt;
  }

  touch(): void {
    this.lastUsedAt = Date.now();
  }

  /** Lazily launches the browser; reuses it across every browser.* tool call. */
  async ensureLaunched(): Promise<Browser> {
    if (this.isDisposed)
      throw new Error(
        "This session's browser was closed; call browser.navigate to start a new one.",
      );
    this.touch();
    if (this.browser) {
      if (this.browser.isConnected()) return this.browser;
      // The browser died underneath us (crash or external kill); rebuild.
      this.browser = null;
      this.context = null;
    }
    const launcher = this.config.launcher ?? launchWithFallback;
    const { browser, source } = await launcher(this.config.headless ?? true);
    this.launchSource = source;
    this.browser = browser;
    browser.on("disconnected", () => {
      this.browser = null;
      this.context = null;
      this.pages.clear();
      this.activePageSeq = null;
    });
    this.context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      ignoreHTTPSErrors: true,
    });
    this.context.on("page", (page) => this.registerPage(page));
    return browser;
  }

  private registerPage(page: Page): PageMeta {
    const meta: PageMeta = { seq: this.nextPageSeq++, page };
    this.pages.set(meta.seq, meta);
    this.wirePage(meta);
    this.activePageSeq = meta.seq;
    return meta;
  }

  private wirePage(meta: PageMeta): void {
    const { page } = meta;
    page.on("console", (message) => {
      this.consoleBuffer.push({
        seq: this.nextConsoleSeq++,
        level: message.type(),
        text: message.text().slice(0, 2_000),
        url: page.url() || null,
        at: timestamp(),
      });
    });
    page.on("pageerror", (error) => {
      this.consoleBuffer.push({
        seq: this.nextConsoleSeq++,
        level: "pageerror",
        text: String(error?.message ?? error).slice(0, 2_000),
        url: page.url() || null,
        at: timestamp(),
      });
    });
    page.on("requestfailed", (request) => {
      this.networkBuffer.push({
        seq: this.nextNetworkSeq++,
        method: request.method(),
        url: request.url(),
        status: null,
        resourceType: request.resourceType(),
        contentType: null,
        error: request.failure()?.errorText ?? "request failed",
        at: timestamp(),
        response: null,
      });
    });
    page.on("response", (response) => {
      const request = response.request();
      this.networkBuffer.push({
        seq: this.nextNetworkSeq++,
        method: request.method(),
        url: response.url(),
        status: response.status(),
        resourceType: request.resourceType(),
        contentType: response.headers()["content-type"] ?? null,
        error: null,
        at: timestamp(),
        response,
      });
    });
  }

  /**
   * Resolve the page a tool should act on. `pageSeq` selects an open tab;
   * `newTab` opens one; without either the most recently opened/used tab wins.
   */
  async resolvePage(options: { newTab?: boolean; pageSeq?: number } = {}): Promise<PageMeta> {
    await this.ensureLaunched();
    this.touch();
    if (options.pageSeq != null) {
      const meta = this.pages.get(options.pageSeq);
      if (!meta || meta.page.isClosed())
        throw new Error(
          `Tab ${options.pageSeq} is not open. Current tabs: ${this.describeTabs()}`,
        );
      this.activePageSeq = meta.seq;
      return meta;
    }
    if (!options.newTab) {
      const active = this.activePageSeq != null ? this.pages.get(this.activePageSeq) : undefined;
      if (active && !active.page.isClosed()) return active;
      const any = [...this.pages.values()].find((meta) => !meta.page.isClosed());
      if (any) {
        this.activePageSeq = any.seq;
        return any;
      }
    }
    // newPage() also fires the context "page" event, which registers the tab;
    // fall back to explicit registration only if the event never reached us.
    const page = await this.context!.newPage();
    const existing = [...this.pages.values()].find((meta) => meta.page === page);
    if (existing) {
      this.activePageSeq = existing.seq;
      return existing;
    }
    return this.registerPage(page);
  }

  describeTabs(): string {
    const tabs = [...this.pages.values()]
      .filter((meta) => !meta.page.isClosed())
      .map(
        (meta) =>
          `tab ${meta.seq}${meta.seq === this.activePageSeq ? "*" : ""}: ${meta.page.url() || "about:blank"}`,
      );
    return tabs.length ? tabs.join("; ") : "no open tabs";
  }

  tabs(): Array<{ seq: number; url: string; active: boolean }> {
    return [...this.pages.values()]
      .filter((meta) => !meta.page.isClosed())
      .map((meta) => ({
        seq: meta.seq,
        url: meta.page.url() || "about:blank",
        active: meta.seq === this.activePageSeq,
      }));
  }

  /** Playwright refs look like `e12` (main frame) or `f1e5` (inside an iframe). */
  static isValidRef(ref: string): boolean {
    return /^(f\d+)?e\d+$/.test(ref);
  }

  async closeTab(pageSeq: number): Promise<void> {
    const meta = this.pages.get(pageSeq);
    if (!meta || meta.page.isClosed())
      throw new Error(`Tab ${pageSeq} is not open. Current tabs: ${this.describeTabs()}`);
    await meta.page.close().catch(() => undefined);
    this.pages.delete(pageSeq);
    if (this.activePageSeq === pageSeq) {
      const remaining = [...this.pages.keys()];
      this.activePageSeq = remaining.length ? remaining[remaining.length - 1]! : null;
    }
    this.touch();
  }

  /** Idempotent full teardown; safe to call from GC sweeps and shutdown hooks. */
  dispose(reason: string): Promise<void> {
    if (!this.disposing) {
      this.isDisposed = true;
      this.disposing = (async () => {
        const context = this.context;
        this.context = null;
        const browser = this.browser;
        this.browser = null;
        this.pages.clear();
        this.activePageSeq = null;
        await context?.close().catch(() => undefined);
        await browser?.close().catch(() => undefined);
      })();
    }
    void reason;
    return this.disposing;
  }
}

export function validateHttpUrl(raw: string): URL {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new Error(`"${raw.trim().slice(0, 200)}" is not a valid URL.`);
  }
  if (!["http:", "https:"].includes(url.protocol))
    throw new Error(
      `Only http:// and https:// URLs can be opened (got ${url.protocol}). Other schemes such as file:// are blocked so browsing cannot read local files.`,
    );
  return url;
}

export async function gotoPage(
  page: Page,
  url: URL,
  timeoutMs: number | undefined,
): Promise<void> {
  await page.goto(url.href, {
    waitUntil: "load",
    timeout: timeoutMs ?? NAVIGATION_TIMEOUT_MS,
  });
}
