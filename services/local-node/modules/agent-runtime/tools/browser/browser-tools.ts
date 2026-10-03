import * as z from "zod/v4";
import type { Page } from "playwright-core";
import type { RegisteredTool, ToolExecutionInput } from "../../contracts.js";
import { agentRuntimeStore } from "../../session-store.js";
import { createAsset } from "../../media-assets.js";
import { acquireBrowserSession, closeBrowserSession } from "./browser-manager.js";
import { gotoPage, validateHttpUrl } from "./browser-session.js";
import { defaultHeadless } from "./browser-launch.js";

const SNAPSHOT_CHAR_LIMIT = 60_000;
const EVALUATE_TIMEOUT_MS = 15_000;
const ACTION_TIMEOUT_MS = 8_000;
const WAIT_TIMEOUT_MS = 30_000;
const SCREENSHOT_TIMEOUT_MS = 20_000;
const NETWORK_BODY_CHAR_LIMIT = 50_000;
const EVALUATE_RESULT_CHAR_LIMIT = 50_000;

const refSchema = z
  .string()
  .regex(/^(f\d+)?e\d+$/, "Use an [ref=eN] handle copied from a browser.snapshot or browser.navigate result (iframe refs look like f1e5).");

function baseTool(): Pick<RegisteredTool, "category" | "internalGate" | "mutability" | "resumeBehavior"> {
  return {
    // Browsing never touches the workspace, so it mounts as read; profiles that
    // debug (executor + primary Synax agent) list these tools explicitly.
    category: "read",
    internalGate: "none",
    mutability: "read",
    resumeBehavior: "auto",
  };
}

async function withTimeout<T>(task: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      task,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s.`)), ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function sessionFor(input: ToolExecutionInput, headless?: boolean) {
  return acquireBrowserSession({
    sessionId: input.sessionId,
    headless: headless ?? defaultHeadless(),
  });
}

function refLocator(page: Page, ref: string) {
  return page.locator(`aria-ref=${ref}`);
}

async function snapshotYaml(page: Page, depth?: number): Promise<string> {
  const yaml = await page.locator("body").ariaSnapshot({
    mode: "ai",
    ...(depth != null ? { depth } : {}),
  });
  if (yaml.length > SNAPSHOT_CHAR_LIMIT)
    return `${yaml.slice(0, SNAPSHOT_CHAR_LIMIT)}\n… [snapshot truncated at ${SNAPSHOT_CHAR_LIMIT} chars; pass depth to limit, or target a smaller region via browser.evaluate]`;
  return yaml;
}

function describeRefFailure(error: unknown, ref: string): Error {
  const message = error instanceof Error ? error.message : String(error);
  if (/strict mode violation|resolved to \d+ elements/i.test(message) || /waiting for locator|Timeout .* exceeded/i.test(message))
    return new Error(
      `Ref ${ref} no longer resolves to its element (the page changed since the last snapshot). Run browser.snapshot again and use a fresh [ref=eN]. (${message})`,
    );
  return error instanceof Error ? error : new Error(message);
}

interface PageState {
  url: string;
  title: string;
}

async function pageState(page: Page): Promise<PageState> {
  let title = "";
  try {
    title = await withTimeout(page.title(), 3_000, "Reading the page title");
  } catch {
    title = "";
  }
  return { url: page.url() || "about:blank", title };
}

function tabsOf(session: Awaited<ReturnType<typeof sessionFor>>) {
  return session.tabs();
}

async function stateWithSnapshot(
  page: Page,
  session: Awaited<ReturnType<typeof sessionFor>>,
  depth?: number,
): Promise<Record<string, unknown>> {
  const [state, yaml] = await Promise.all([pageState(page), snapshotYaml(page, depth).catch((error) => `Snapshot failed: ${error instanceof Error ? error.message : String(error)}`)]);
  return {
    ...state,
    tabs: tabsOf(session),
    snapshot: yaml,
    hint: "Interact with [ref=eN] handles via browser.click / browser.type. Re-snapshot after navigation; refs go stale.",
  };
}

const navigateSchema = z
  .object({
    url: z.string().trim().min(1).max(2048).optional()
      .describe("Absolute http(s) URL to open. Omit only when switching tabs with pageSeq."),
    newTab: z.boolean().optional().describe("Open the URL in a new tab instead of the active one."),
    pageSeq: z.number().int().positive().optional().describe("Switch to this open tab (see the tabs list in any result) instead of navigating; url may be omitted."),
    headless: z.boolean().optional().describe(`Run without a visible window. Defaults to ${"SYNAX_BROWSER_HEADLESS"} or true. Only applies the first time the browser launches.`),
    timeoutMs: z.number().int().min(1_000).max(120_000).optional().describe("Navigation timeout in ms (default 30000). Raise it for slow dev-server cold starts."),
    depth: z.number().int().min(1).max(30).optional().describe("Limit snapshot depth for very large pages."),
  })
  .strict();

const snapshotSchema = z
  .object({
    pageSeq: z.number().int().positive().optional().describe("Snapshot a specific tab instead of the active one."),
    depth: z.number().int().min(1).max(30).optional().describe("Limit snapshot depth for very large pages."),
  })
  .strict();

const clickSchema = z
  .object({
    ref: refSchema.describe("Element handle from the latest snapshot, e.g. e12."),
    button: z.enum(["left", "right"]).optional().describe("Mouse button (default left)."),
    doubleClick: z.boolean().optional(),
    snapshot: z.boolean().optional().describe("Return a fresh snapshot after the click (default true)."),
  })
  .strict();

const typeSchema = z
  .object({
    ref: refSchema.describe("Text field handle from the latest snapshot."),
    text: z.string().max(10_000).describe("Text to fill into the field (replaces existing content)."),
    submit: z.boolean().optional().describe("Press Enter after filling (for search boxes and forms)."),
    snapshot: z.boolean().optional().describe("Return a fresh snapshot afterwards (default true)."),
  })
  .strict();

const screenshotSchema = z
  .object({
    fullPage: z.boolean().optional().describe("Capture the whole scrollable page (default: viewport only)."),
    ref: refSchema.optional().describe("Capture a single element instead of the page."),
    filename: z.string().min(1).max(120).optional().describe("Asset filename hint, e.g. login-page.jpg."),
  })
  .strict();

const consoleSchema = z
  .object({
    kind: z.enum(["all", "log", "info", "warning", "error", "pageerror"]).optional().describe("Filter by message level (default all). pageerror entries are uncaught page exceptions."),
    sinceSeq: z.number().int().positive().optional().describe("Only entries after this seq (use the returned nextSeq cursor for incremental reads)."),
    limit: z.number().int().min(1).max(200).optional().describe("Most recent entries to return (default 50)."),
  })
  .strict();

const networkSchema = z
  .object({
    filter: z.string().min(1).max(500).optional().describe("Substring filter applied to URLs."),
    sinceSeq: z.number().int().positive().optional().describe("Only entries after this seq."),
    limit: z.number().int().min(1).max(200).optional().describe("Most recent entries to return (default 50)."),
    seq: z.number().int().positive().optional().describe("Fetch one entry with its response body instead of listing."),
  })
  .strict();

const evaluateSchema = z
  .object({
    expression: z.string().min(1).max(20_000).describe("JavaScript to evaluate in the page, e.g. `document.title` or `(() => { ... return x; })()`. Runs with the page's origin and cookies; never handle credentials here."),
    ref: refSchema.optional().describe("Evaluate against one element instead of the window: pass a function like `(el) => el.textContent`."),
  })
  .strict();

const waitSchema = z
  .object({
    text: z.string().min(1).max(500).optional().describe("Wait until this text becomes visible."),
    selector: z.string().min(1).max(500).optional().describe("Wait until this CSS selector matches."),
    timeMs: z.number().int().min(1).max(30_000).optional().describe("Plain delay in ms."),
    timeoutMs: z.number().int().min(1_000).max(30_000).optional().describe("Max wait for text/selector (default 10000)."),
  })
  .strict()
  .refine((args) => [args.text, args.selector, args.timeMs].filter(Boolean).length === 1, "Provide exactly one of text, selector or timeMs.");

const closeSchema = z
  .object({
    scope: z.enum(["tab", "browser"]).optional().describe("Close one tab or the whole browser (default browser)."),
    pageSeq: z.number().int().positive().optional().describe("Tab to close when scope is tab (default: active tab)."),
  })
  .strict();

async function optionalSnapshot(
  page: Page,
  session: Awaited<ReturnType<typeof sessionFor>>,
  enabled: boolean | undefined,
): Promise<Record<string, unknown> | undefined> {
  if (enabled === false) return undefined;
  return stateWithSnapshot(page, session);
}

export const browserTools: RegisteredTool[] = [
  {
    ...baseTool(),
    id: "browser.navigate",
    label: "Browser Navigate",
    description:
      "Open or switch tabs in this session's Chromium via Playwright and return an accessibility snapshot with [ref=eN] handles for interaction. Use for end-to-end debugging of web apps (local dev servers welcome). Only http(s) URLs; file:// is blocked. The browser stays open across browser.* calls until browser.close or idle timeout.",
    progressiveDetails:
      "Accepts { url?, newTab?, pageSeq?, headless?, timeoutMs?, depth? }. Returns page url/title, open tabs and an AI snapshot with element refs. Feed refs into browser.click / browser.type.",
    inputSchema: navigateSchema,
    async execute(input) {
      const args = navigateSchema.parse(input.args);
      const session = await sessionFor(input, args.headless);
      if (!args.url && args.pageSeq == null)
        throw new Error("Provide a URL to open (or a pageSeq to switch tabs).");
      if (args.url) {
        const url = validateHttpUrl(args.url);
        const { page } = await session.resolvePage({ newTab: args.newTab });
        try {
          await gotoPage(page, url, args.timeoutMs);
        } catch (error) {
          throw new Error(
            `Navigation to ${url.href} failed: ${error instanceof Error ? error.message : String(error)}. Is the server running? Raise timeoutMs for slow first loads.`,
          );
        }
        return {
          result: await stateWithSnapshot(page, session, args.depth),
          displaySummary: `Opened ${url.href}`,
          artifacts: [],
          followUpHints: ["Use browser.click / browser.type with [ref=eN] handles from the snapshot."],
        };
      }
      const { page } = await session.resolvePage({ pageSeq: args.pageSeq });
      return {
        result: await stateWithSnapshot(page, session, args.depth),
        displaySummary: `Switched to tab ${args.pageSeq}: ${page.url()}`,
        artifacts: [],
      };
    },
  },
  {
    ...baseTool(),
    id: "browser.snapshot",
    label: "Browser Snapshot",
    description:
      "Capture the current page's accessibility tree with [ref=eN] element handles. This is how you see the page: run it after every navigation and before interacting. Cheaper and more precise than screenshots.",
    progressiveDetails: "Accepts { pageSeq?, depth? }. Returns YAML-formatted accessibility tree plus the open-tab list.",
    inputSchema: snapshotSchema,
    async execute(input) {
      const args = snapshotSchema.parse(input.args);
      const session = await sessionFor(input);
      const { page } = await session.resolvePage({ pageSeq: args.pageSeq });
      return {
        result: await stateWithSnapshot(page, session, args.depth),
        displaySummary: `Snapshot of ${page.url()}`,
        artifacts: [],
      };
    },
  },
  {
    ...baseTool(),
    id: "browser.click",
    label: "Browser Click",
    description:
      "Click an element from the latest browser.snapshot by its [ref=eN] handle. Returns the updated snapshot so you can see the effect immediately.",
    progressiveDetails: "Accepts { ref, button?, doubleClick?, snapshot? }. Refs go stale after navigation — re-snapshot first.",
    inputSchema: clickSchema,
    async execute(input) {
      const args = clickSchema.parse(input.args);
      const session = await sessionFor(input);
      const { page } = await session.resolvePage();
      try {
        await refLocator(page, args.ref).click({
          button: args.button,
          clickCount: args.doubleClick ? 2 : 1,
          timeout: ACTION_TIMEOUT_MS,
        });
      } catch (error) {
        throw describeRefFailure(error, args.ref);
      }
      return {
        result: {
          clicked: args.ref,
          url: page.url(),
          ...(await optionalSnapshot(page, session, args.snapshot)),
        },
        displaySummary: `Clicked ${args.ref} on ${page.url()}`,
        artifacts: [],
      };
    },
  },
  {
    ...baseTool(),
    id: "browser.type",
    label: "Browser Type",
    description:
      "Fill a text field from the latest browser.snapshot by its [ref=eN] handle, optionally pressing Enter. Returns the updated snapshot.",
    progressiveDetails: "Accepts { ref, text, submit?, snapshot? }. Fills replace the field's content.",
    inputSchema: typeSchema,
    async execute(input) {
      const args = typeSchema.parse(input.args);
      const session = await sessionFor(input);
      const { page } = await session.resolvePage();
      const locator = refLocator(page, args.ref);
      try {
        await locator.fill(args.text, { timeout: ACTION_TIMEOUT_MS });
        if (args.submit) await locator.press("Enter", { timeout: ACTION_TIMEOUT_MS });
      } catch (error) {
        throw describeRefFailure(error, args.ref);
      }
      return {
        result: {
          filled: args.ref,
          submit: args.submit === true,
          url: page.url(),
          ...(await optionalSnapshot(page, session, args.snapshot)),
        },
        displaySummary: `Filled ${args.ref}${args.submit ? " and pressed Enter" : ""}`,
        artifacts: [],
      };
    },
  },
  {
    ...baseTool(),
    id: "browser.screenshot",
    label: "Browser Screenshot",
    description:
      "Capture the page (or one element) as an image you can see. Use when layout/visuals matter; prefer browser.snapshot for structure. The image is attached to this session as an asset.",
    progressiveDetails: "Accepts { fullPage?, ref?, filename? }. Returns an image content part plus the asset id.",
    inputSchema: screenshotSchema,
    async execute(input) {
      const args = screenshotSchema.parse(input.args);
      const session = await sessionFor(input);
      const { page } = await session.resolvePage();
      const buffer = args.ref
        ? await refLocator(page, args.ref)
            .screenshot({ type: "jpeg", quality: 70, timeout: SCREENSHOT_TIMEOUT_MS })
            .catch((error) => {
              throw describeRefFailure(error, args.ref!);
            })
        : await page.screenshot({
            fullPage: args.fullPage === true,
            type: "jpeg",
            quality: 70,
            timeout: SCREENSHOT_TIMEOUT_MS,
          });
      const project = agentRuntimeStore.getSession(input.sessionId);
      const filename = `${args.filename?.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "") || `browser-${Date.now()}`}.jpg`;
      const asset = await createAsset(project.projectId, filename, Buffer.from(buffer), "image/jpeg");
      const state = await pageState(page);
      return {
        result: { asset, url: state.url, fullPage: args.fullPage === true },
        contentParts: [{ type: "image", assetId: asset.id }],
        displaySummary: `Screenshot of ${state.url} (${asset.filename}, ${asset.size} bytes)`,
        artifacts: [
          {
            kind: "evidence",
            title: "Browser screenshot",
            summary: `${state.url} captured as ${asset.filename}`,
            risk: "low",
            metadata: { assetId: asset.id, url: state.url },
          },
        ],
      };
    },
  },
  {
    ...baseTool(),
    id: "browser.console",
    label: "Browser Console",
    description:
      "Read captured console messages and uncaught page errors from this session's browser. Use it to diagnose client-side errors during end-to-end debugging.",
    progressiveDetails: "Accepts { kind?, sinceSeq?, limit? }. Entries carry a seq cursor for incremental reads; buffer holds the most recent 600.",
    inputSchema: consoleSchema,
    async execute(input) {
      const args = consoleSchema.parse(input.args);
      const session = await sessionFor(input);
      let entries = session.consoleBuffer.items;
      if (args.sinceSeq != null) entries = entries.filter((entry) => entry.seq > args.sinceSeq!);
      if (args.kind && args.kind !== "all")
        entries = entries.filter((entry) => entry.level === args.kind);
      const total = entries.length;
      const limit = args.limit ?? 50;
      const tail = entries.slice(-limit);
      const nextSeq = session.consoleBuffer.items.at(-1)?.seq ?? 0;
      return {
        result: {
          entries: tail,
          returned: tail.length,
          totalMatching: total,
          nextSeq,
          tabs: tabsOf(session),
        },
        displaySummary: `${tail.length} console entr${tail.length === 1 ? "y" : "ies"} (${args.kind ?? "all"})`,
        artifacts: [],
        followUpHints: tail.some((entry) => entry.level === "pageerror" || entry.level === "error")
          ? ["Uncaught errors are present; correlate them with the network requests around the same time."]
          : [],
      };
    },
  },
  {
    ...baseTool(),
    id: "browser.network",
    label: "Browser Network",
    description:
      "List captured network requests (method, status, type, URL) or fetch one response body by seq. Use it to debug API traffic the page produced.",
    progressiveDetails:
      "Accepts { filter?, sinceSeq?, limit? } to list, or { seq } to read one entry with its response body (text-ish bodies up to 50k chars). Buffer holds the most recent 400.",
    inputSchema: networkSchema,
    async execute(input) {
      const args = networkSchema.parse(input.args);
      const session = await sessionFor(input);
      if (args.seq != null) {
        const entry = session.networkBuffer.items.find((item) => item.seq === args.seq);
        if (!entry)
          throw new Error(`No network entry with seq ${args.seq} (buffer holds the most recent ${session.networkBuffer.length}).`);
        let body: { text?: string; bytes: number; truncated?: boolean; note?: string } | null = null;
        if (entry.response) {
          try {
            const raw = await withTimeout(entry.response.body(), 10_000, "Reading the response body");
            const text = raw.toString("utf8");
            body = text.length > NETWORK_BODY_CHAR_LIMIT
              ? { text: text.slice(0, NETWORK_BODY_CHAR_LIMIT), bytes: raw.byteLength, truncated: true }
              : { text, bytes: raw.byteLength };
          } catch (error) {
            body = { bytes: 0, note: `Body unavailable (navigation or eviction): ${error instanceof Error ? error.message : String(error)}` };
          }
        } else {
          body = { bytes: 0, note: "No response captured for this entry (request failed)." };
        }
        const { response: _response, ...rest } = entry;
        return {
          result: { entry: rest, body },
          displaySummary: `Network ${entry.seq}: ${entry.method} ${entry.url}`,
          artifacts: [],
        };
      }
      let entries = session.networkBuffer.items;
      if (args.sinceSeq != null) entries = entries.filter((entry) => entry.seq > args.sinceSeq!);
      if (args.filter) entries = entries.filter((entry) => entry.url.includes(args.filter!));
      const total = entries.length;
      const limit = args.limit ?? 50;
      const tail = entries.slice(-limit).map(({ response: _response, ...rest }) => rest);
      const nextSeq = session.networkBuffer.items.at(-1)?.seq ?? 0;
      return {
        result: { entries: tail, returned: tail.length, totalMatching: total, nextSeq },
        displaySummary: `${tail.length} network entr${tail.length === 1 ? "y" : "ies"}${args.filter ? ` matching "${args.filter}"` : ""}`,
        artifacts: [],
      };
    },
  },
  {
    ...baseTool(),
    id: "browser.evaluate",
    label: "Browser Evaluate",
    description:
      "Run JavaScript inside the current page and get the JSON-serializable result. The escape hatch for anything the structured tools miss: read state, inspect the DOM, call page APIs. Runs with the page's origin and cookies — never touch credentials.",
    progressiveDetails:
      "Accepts { expression, ref? }. Without ref the expression evaluates in the window context (`document.title`). With ref, evaluate a function against that element (`(el) => el.textContent`).",
    inputSchema: evaluateSchema,
    async execute(input) {
      const args = evaluateSchema.parse(input.args);
      const session = await sessionFor(input);
      const { page } = await session.resolvePage();
      let value: unknown;
      if (args.ref) {
        try {
          value = await withTimeout(
            refLocator(page, args.ref).evaluate(args.expression),
            EVALUATE_TIMEOUT_MS,
            "Evaluating in the element",
          );
        } catch (error) {
          throw describeRefFailure(error, args.ref);
        }
      } else {
        value = await withTimeout(
          page.evaluate(args.expression),
          EVALUATE_TIMEOUT_MS,
          "Evaluating in the page",
        );
      }
      let serialized: string;
      try {
        serialized = JSON.stringify(value) ?? String(value);
      } catch {
        serialized = String(value);
      }
      if (serialized.length > EVALUATE_RESULT_CHAR_LIMIT)
        serialized = `${serialized.slice(0, EVALUATE_RESULT_CHAR_LIMIT)}… [truncated]`;
      return {
        result: { value: serialized, url: page.url() },
        displaySummary: `Evaluated JS in ${page.url()} → ${serialized.slice(0, 120)}`,
        artifacts: [],
      };
    },
  },
  {
    ...baseTool(),
    id: "browser.wait",
    label: "Browser Wait",
    description:
      "Wait for text to appear, a CSS selector to match, or a fixed delay. Use between actions instead of guessing whether the app finished updating.",
    progressiveDetails: "Accepts exactly one of { text, selector, timeMs }; optional timeoutMs (max 30s) for text/selector waits.",
    inputSchema: waitSchema,
    async execute(input) {
      const args = waitSchema.parse(input.args);
      const session = await sessionFor(input);
      const { page } = await session.resolvePage();
      const timeout = Math.min(args.timeoutMs ?? 10_000, WAIT_TIMEOUT_MS);
      if (args.timeMs != null) {
        await new Promise((resolve) => setTimeout(resolve, args.timeMs));
        return { result: { waitedMs: args.timeMs, url: page.url() }, displaySummary: `Waited ${args.timeMs}ms`, artifacts: [] };
      }
      if (args.text != null) {
        await page.getByText(args.text).first().waitFor({ state: "visible", timeout }).catch(() => {
          throw new Error(`Text "${args.text}" did not become visible within ${timeout}ms. Run browser.snapshot to see the current state.`);
        });
        return { result: { matched: args.text, url: page.url() }, displaySummary: `Text "${args.text}" is visible`, artifacts: [] };
      }
      const selector = args.selector!;
      const matched = await page.waitForSelector(selector, { timeout }).catch(() => null);
      if (!matched)
        throw new Error(`Selector "${selector}" did not match within ${timeout}ms. Run browser.snapshot to see the current state.`);
      return { result: { matched: selector, url: page.url() }, displaySummary: `Selector "${selector}" matched`, artifacts: [] };
    },
  },
  {
    ...baseTool(),
    id: "browser.close",
    label: "Browser Close",
    description:
      "Close the browser (default) or a single tab. Call it when finished debugging; sessions also auto-close after 10 idle minutes.",
    progressiveDetails: "Accepts { scope?: 'tab' | 'browser', pageSeq? }.",
    inputSchema: closeSchema,
    async execute(input) {
      const args = closeSchema.parse(input.args);
      if (args.scope === "tab") {
        const session = await sessionFor(input);
        await session.closeTab(args.pageSeq ?? session.tabs().find((tab) => tab.active)?.seq ?? 0);
        return {
          result: { closed: "tab", tabs: tabsOf(session) },
          displaySummary: "Closed the tab.",
          artifacts: [],
        };
      }
      await closeBrowserSession(input.sessionId, "Closed by browser.close.");
      return {
        result: { closed: "browser" },
        displaySummary: "Closed this session's browser.",
        artifacts: [],
      };
    },
  },
];

export const BROWSER_TOOL_IDS = browserTools.map((tool) => tool.id);

/** Read-only subset mounted for review-style profiles. */
export const BROWSER_READ_TOOL_IDS = [
  "browser.navigate",
  "browser.snapshot",
  "browser.screenshot",
  "browser.console",
  "browser.network",
  "browser.wait",
];
