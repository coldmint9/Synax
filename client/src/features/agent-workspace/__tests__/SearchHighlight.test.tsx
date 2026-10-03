import { describe, expect, it } from "vitest";
import { render } from "@testing-library/react";
import { SearchHighlight } from "../SearchHighlight";

describe("SearchHighlight", () => {
  it.each([["全文检索，全文匹配", "全文", 2], ["Needle NEEDLE", "needle", 2], ["a.*b a12b", "a.*b", 1], ['<img src=x onerror=alert(1)>', "<img", 1]])("highlights literal matches safely: %s", (text, query, count) => {
    const { container } = render(<SearchHighlight text={text} query={query} />);
    expect(container.textContent).toBe(text);
    expect(container.querySelectorAll("mark")).toHaveLength(count);
    expect(container.querySelector("img")).toBeNull();
  });
});
