import { describe, expect, it } from "vitest";
import { mergeRequestRef, mergeRequestTerms } from "./mrTerms";

describe("merge request naming", () => {
  it("names GitLab requests MR with the platform exclamation reference", () => {
    const terms = mergeRequestTerms("gitlab");
    expect(terms).toMatchObject({ platform: "GitLab", short: "MR", symbol: "!" });
    expect(mergeRequestRef(terms, 42)).toBe("MR !42");
  });

  it("keeps GitHub pull request wording for GitHub remotes", () => {
    const terms = mergeRequestTerms("github");
    expect(terms).toMatchObject({ platform: "GitHub", short: "PR", symbol: "#" });
    expect(mergeRequestRef(terms, 7)).toBe("PR #7");
  });

  it("defaults an unresolved provider to the integrated GitLab platform", () => {
    expect(mergeRequestTerms(undefined).short).toBe("MR");
  });
});
