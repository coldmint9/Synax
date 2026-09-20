import { afterEach, describe, expect, it, vi } from "vitest";
import type { WebSearchConfig } from "../../../lib/config/config-types.js";
import { parseJsonResults, searchWithConfig } from "../tools/web-search.js";
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
