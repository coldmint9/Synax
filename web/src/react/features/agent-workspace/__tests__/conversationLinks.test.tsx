import postcss from "postcss";
import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import css from "../../../../index.css?raw";
import { WebSearchResults } from "../WebSearchResults";

// happy-dom does not apply Tailwind; inspect the source rule as well as the
// rendered search link, then verify computed styles in a real browser.
describe("conversation link appearance", () => {
  it("removes underlines from transcript anchors, including file links", () => {
    const rules: string[] = [];
    postcss.parse(css).walkRules(".feed-prose a", (rule) => {
      rules.push(rule.toString());
    });
    expect(rules.join("\n")).toContain("no-underline");
    expect(rules.join("\n")).not.toMatch(/(?<![\w-])underline(?![\w-])/);
  });

  it("keeps search results clickable without default or hover underlines", () => {
    render(
      <WebSearchResults
        output={{
          type: "web_search_results",
          provider: "test",
          results: [
            {
              referenceId: "result-1",
              title: "Documentation",
              url: "https://example.com/docs",
              snippet: "Search result",
            },
          ],
        }}
      />,
    );
    const link = screen.getByRole("link", { name: "1. Documentation" });
    expect(link).toHaveClass("no-underline", "hover:no-underline");
    expect(link).not.toHaveClass("underline");
    expect(link).toHaveAttribute("href", "https://example.com/docs");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });
});
