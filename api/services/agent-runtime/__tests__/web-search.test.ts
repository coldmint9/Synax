import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSearchConfig } from "../../../lib/config/config-types.js";
import {
  parseJsonResults,
  searchBatchWithConfig,
  searchWithConfig,
  webSearchTool,
} from "../tools/web-search.js";
import { resolveWebSearchAuthorization } from "../../web-search/oauth.js";

function config(local: Partial<WebSearchConfig["local"]>): WebSearchConfig {
  return {
    routing: "local",
    remote: { externalWebAccess: true, searchContextSize: "medium" },
    local: {
      engine: "custom",
      auth: { type: "none" },
      ...local,
    },
  };
}

describe("configured local web search engines", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("falls back to a public no-auth engine when the configured channel has no credentials", async () => {
    const fetchMock = vi.fn(
      async (_input: string | URL | Request) =>
        new Response(
          `<html><body><div class="result"><a class="result__a" href="https://example.com/public">Public result</a><div class="result__snippet">Public snippet</div></div></body></html>`,
          { status: 200, headers: { "Content-Type": "text/html" } },
        ),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await searchWithConfig(
      { query: "public", limit: 5 },
      config({ engine: "brave", auth: { type: "api-key" } }),
    );

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String(fetchMock.mock.calls[0]?.[0])).toContain("duckduckgo.com");
    expect(result.provider).toBe("DuckDuckGo (public fallback)");
    expect(result.fallbackReason).toContain("API key is not configured");
    expect(result.hits[0]).toMatchObject({
      title: "Public result",
      url: "https://example.com/public",
    });
  });

  it("parses Brave and custom JSON shapes with domain filtering", () => {
    const brave = parseJsonResults(
      {
        web: {
          results: [
            {
              title: "Docs",
              url: "https://docs.example.com/a",
              description: "A",
            },
            { title: "Other", url: "https://other.test/b", description: "B" },
          ],
        },
      },
      { query: "docs", limit: 5, domains: ["example.com"] },
      config({ engine: "brave", auth: { type: "none" } }),
    );
    expect(brave).toEqual([
      { title: "Docs", url: "https://docs.example.com/a", snippet: "A" },
    ]);

    const custom = parseJsonResults(
      {
        data: {
          items: [
            { heading: "One", link: "https://example.com/1", body: "Text" },
          ],
        },
      },
      { query: "one", limit: 3 },
      config({
        resultPath: "data.items",
        titleField: "heading",
        urlField: "link",
        snippetField: "body",
      }),
    );
    expect(custom[0]).toMatchObject({ title: "One", snippet: "Text" });
  });

  it("builds engine-specific and custom authorization headers", async () => {
    await expect(
      resolveWebSearchAuthorization(
        config({
          engine: "brave",
          auth: { type: "api-key", apiKey: "brave-key" },
        }),
      ),
    ).resolves.toEqual({ "X-Subscription-Token": "brave-key" });

    await expect(
      resolveWebSearchAuthorization(
        config({
          auth: {
            type: "api-key",
            apiKey: "custom-key",
            headerName: "X-Search-Key",
            tokenPrefix: "Token ",
          },
        }),
      ),
    ).resolves.toEqual({ "X-Search-Key": "Token custom-key" });
  });
});

describe("batched concurrent web search", () => {
  afterEach(() => vi.unstubAllGlobals());

  const ddgoConfig = config({ engine: "duckduckgo", auth: { type: "none" } });
  const html = (title: string) =>
    `<html><body><div class="result"><a class="result__a" href="https://example.com/${title}">${title}</a><div class="result__snippet">s-${title}</div></div></body></html>`;

  it("requires exactly one of query or queries", () => {
    const schema = webSearchTool.inputSchema!;
    expect(
      schema.safeParse({ query: "a" }).success,
    ).toBe(true);
    expect(schema.safeParse({ queries: ["a", "b"] }).success).toBe(true);
    expect(
      schema.safeParse({ query: "a", queries: ["b"] }).success,
    ).toBe(false);
    expect(schema.safeParse({}).success).toBe(false);
  });

  it("starts every batched query before any resolves and merges annotated results", async () => {
    const resolvers: Array<(response: Response) => void> = [];
    const fetchMock = vi.fn(
      (input: string | URL | Request) =>
        new Promise<Response>((resolve) => {
          resolvers.push(resolve);
        }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const argsList = [
      { query: "alpha", limit: 5 },
      { query: "beta", limit: 5 },
      { query: "gamma", limit: 5 },
    ];
    const batchPromise = searchBatchWithConfig(argsList, ddgoConfig);

    // All three requests are in flight before any resolution: concurrent.
    expect(resolvers.length).toBe(3);

    // Resolve out of start order; merged output must still follow input order.
    resolvers[2]!(
      new Response(html("gamma"), {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );
    resolvers[0]!(
      new Response(html("alpha"), {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );
    resolvers[1]!(
      new Response(html("beta"), {
        status: 200,
        headers: { "Content-Type": "text/html" },
      }),
    );

    const batch = await batchPromise;
    expect(batch.failures).toEqual([]);
    expect(batch.providers).toEqual(["DuckDuckGo"]);
    expect(batch.merged.map((hit) => hit.query)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    expect(batch.merged.map((hit) => hit.title)).toEqual([
      "alpha",
      "beta",
      "gamma",
    ]);
    expect(batch.batches.map((entry) => entry.resultCount)).toEqual([1, 1, 1]);
  });

  it("isolates per-query failures and only throws when every query fails", async () => {
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input instanceof Request ? input.url : input);
      const query = new URL(url).searchParams.get("q") ?? "";
      if (query.startsWith("blocked"))
        return new Response("captcha", { status: 429 });
      return new Response(html(query), {
        status: 200,
        headers: { "Content-Type": "text/html" },
      });
    });
    vi.stubGlobal("fetch", fetchMock);

    const batch = await searchBatchWithConfig(
      [
        { query: "blocked", limit: 5 },
        { query: "ok", limit: 5 },
      ],
      ddgoConfig,
    );
    expect(batch.failures.map((failure) => failure.query)).toEqual([
      "blocked",
    ]);
    expect(batch.failures[0]!.error).toContain("429");
    expect(batch.merged.map((hit) => hit.query)).toEqual(["ok"]);

    await expect(
      searchBatchWithConfig(
        [
          { query: "blocked", limit: 5 },
          { query: "blocked-too", limit: 5 },
        ],
        ddgoConfig,
      ),
    ).rejects.toThrow(/429/);
  });
});
