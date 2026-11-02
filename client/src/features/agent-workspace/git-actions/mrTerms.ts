import type { PrProvider } from "../../../adapters/transport/remotePr";

/** Naming used by the host platform: GitLab calls them merge requests, GitHub
 * pull requests. One source of truth so no surface has to guess. */
export interface MergeRequestTerms {
  platform: "GitLab" | "GitHub";
  /** "MR" on GitLab, "PR" on GitHub. */
  short: "MR" | "PR";
  request: "合并请求" | "拉取请求";
  /** GitLab numbers requests with "!" and GitHub with "#". */
  symbol: "!" | "#";
  /** For example "GitLab MR". */
  full: string;
}

/** GitLab is the integrated platform, so an unresolved provider keeps MR
 * wording until the private host is matched to GitHub explicitly. */
export function mergeRequestTerms(provider?: PrProvider): MergeRequestTerms {
  if (provider === "github")
    return {
      platform: "GitHub",
      short: "PR",
      request: "拉取请求",
      symbol: "#",
      full: "GitHub PR",
    };
  return {
    platform: "GitLab",
    short: "MR",
    request: "合并请求",
    symbol: "!",
    full: "GitLab MR",
  };
}

/** Renders the platform reference, for example "MR !42". */
export function mergeRequestRef(
  terms: MergeRequestTerms,
  number: number,
): string {
  return `${terms.short} ${terms.symbol}${number}`;
}
