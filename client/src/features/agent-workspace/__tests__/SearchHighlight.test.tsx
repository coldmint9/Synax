import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { SearchHighlight, highlightTerms } from "../SearchHighlight";

describe("SearchHighlight", () => {
  it.each([["全文检索，全文匹配", "全文", 2], ["Needle NEEDLE", "needle", 2], ["a.*b a12b", "a.*b", 1], ['<img src=x onerror=alert(1)>', "<img", 1]])("highlights literal matches safely: %s", (text, query, count) => {
    const { container } = render(<SearchHighlight text={text} query={query} />);
    expect(container.textContent).toBe(text);
    expect(container.querySelectorAll("mark")).toHaveLength(count);
    expect(container.querySelector("img")).toBeNull();
  });

  it("highlights every keyword the server matched, longest first", () => {
    const { container } = render(
      <SearchHighlight
        text="发布流程需要回滚，发布前先演练回滚"
        terms={["回滚", "发布"]}
      />,
    );
    expect([...container.querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual([
      "发布",
      "回滚",
      "发布",
      "回滚",
    ]);
    expect(container.textContent).toBe("发布流程需要回滚，发布前先演练回滚");
  });

  it("splits a raw query into keywords when no server terms arrived yet", () => {
    const { container } = render(
      <SearchHighlight text="session search highlight" query="search highlight" />,
    );
    expect(container.querySelectorAll("mark")).toHaveLength(2);
  });

  it("escapes regex metacharacters in every keyword", () => {
    const { container } = render(
      <SearchHighlight text="价格是 $5 (净价)" terms={["$5", "(净价)"]} />,
    );
    expect(container.querySelectorAll("mark")).toHaveLength(2);
    expect(container.textContent).toBe("价格是 $5 (净价)");
  });

  it("dedupes keywords and ignores blank ones", () => {
    expect(highlightTerms("", ["a", "a", " "])).toEqual(["a"]);
    expect(highlightTerms("  ")).toEqual([]);
  });
});
