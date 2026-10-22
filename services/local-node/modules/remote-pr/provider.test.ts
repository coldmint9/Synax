import { describe, it, expect, vi } from "vitest";
import { RemotePrProvider } from "./provider.js";
import { parseRemote, remoteChoice, safeRemoteUrl } from "./remote.js";
import type { RemoteRepository, RemotePullRequest } from "./contracts.js";
const sha = "a".repeat(40),
  base = "b".repeat(40);
const github: RemoteRepository = {
  remote: "origin",
  host: "github.com",
  path: "acme/app",
  provider: "github",
};
const gitlab: RemoteRepository = {
  remote: "upstream",
  host: "gitlab.example.com",
  path: "group/sub/app",
  provider: "gitlab",
};
const githubRow = {
  number: 7,
  title: "Refresh sessions",
  body: "Details",
  html_url: "https://github.com/acme/app/pull/7",
  state: "open",
  draft: false,
  head: { ref: "feature/auth", sha, repo: { full_name: "acme/app" } },
  base: { ref: "main", sha: base, repo: { full_name: "acme/app" } },
  mergeable: true,
  mergeable_state: "clean",
  user: { login: "mint" },
  updated_at: "2026-10-22",
};
const gitlabRow = {
  iid: 9,
  title: "Fix sessions",
  description: "Details",
  web_url: "https://gitlab.example.com/group/sub/app/-/merge_requests/9",
  state: "opened",
  draft: false,
  source_branch: "feature/auth",
  target_branch: "main",
  sha,
  diff_refs: { start_sha: base },
  source_project_id: 1,
  target_project_id: 1,
  detailed_merge_status: "mergeable",
  author: { username: "mint" },
  head_pipeline: { id: 123, status: "success" },
};
describe("remote repository identity", () => {
  it("parses SSH, HTTPS, enterprise and nested GitLab paths without exposing credentials", () => {
    expect(parseRemote("origin", "git@github.com:acme/app.git")).toEqual(
      github,
    );
    expect(
      parseRemote("origin", "https://user:secret@github.com/acme/app.git"),
    ).toEqual(github);
    expect(
      parseRemote(
        "upstream",
        "ssh://git@gitlab.example.com/group/sub/app.git",
        "gitlab",
      ),
    ).toEqual(gitlab);
    expect(
      remoteChoice("upstream", "git@gitlab.example.com:group/sub/app.git"),
    ).toMatchObject({
      name: "upstream",
      host: "gitlab.example.com",
      path: "group/sub/app",
    });
  });
  it("rejects platform mismatch, path traversal and unsupported local remotes", () => {
    expect(() =>
      parseRemote("origin", "git@github.com:acme/app.git", "gitlab"),
    ).toThrow(/不匹配/);
    expect(() => parseRemote("origin", "/tmp/repo.git")).toThrow();
    expect(() =>
      parseRemote("origin", "ssh://git@github.com/../app.git"),
    ).toThrow();
    expect(() =>
      parseRemote("origin", "http://github.com/acme/app.git"),
    ).toThrow();
    expect(safeRemoteUrl("javascript:alert(1)", github)).toBe("");
    expect(safeRemoteUrl("https://evil.example/pr", github)).toBe("");
  });
});
describe("GitHub/GitLab provider API", () => {
  it("normalizes actual GitHub checks and sends SHA compare-and-merge", async () => {
    const api = vi.fn(async (_repo, method, endpoint, body) =>
      endpoint.includes("check-runs")
        ? {
            check_runs: [
              { name: "unit", status: "completed", conclusion: "success" },
            ],
          }
        : endpoint.includes("/status")
          ? { statuses: [{ context: "lint", state: "pending" }] }
          : method === "PUT"
            ? { merged: true }
            : githubRow,
    );
    const provider = new RemotePrProvider(api);
    const pr = await provider.get(github, 7);
    expect(pr.checks.map((check) => check.status)).toEqual([
      "passed",
      "pending",
    ]);
    expect(pr.sameRepository).toBe(true);
    await provider.merge(github, pr, "squash");
    expect(api).toHaveBeenLastCalledWith(
      github,
      "PUT",
      "repos/acme/app/pulls/7/merge",
      { sha, merge_method: "squash" },
    );
    await provider.updateBranch(github, pr);
    expect(api).toHaveBeenLastCalledWith(
      github,
      "PUT",
      "repos/acme/app/pulls/7/update-branch",
      { expected_head_sha: sha },
    );
  });
  it("normalizes GitLab pipelines, nested project IDs and SHA-protected merge", async () => {
    const api = vi.fn(async (_repo, method, endpoint) =>
      endpoint.includes("/repository/branches/")
        ? { commit: { id: base } }
        : method === "GET"
          ? gitlabRow
          : {},
    );
    const provider = new RemotePrProvider(api);
    const pr = await provider.get(gitlab, 9);
    expect(pr).toMatchObject({
      number: 9,
      head: "feature/auth",
      base: "main",
      headSha: sha,
      baseSha: base,
      mergeable: true,
      checks: [{ name: "Pipeline #123", status: "passed" }],
    });
    await provider.merge(gitlab, pr, "squash");
    expect(api).toHaveBeenLastCalledWith(
      gitlab,
      "PUT",
      "projects/group%2Fsub%2Fapp/merge_requests/9/merge",
      { sha, squash: true, should_remove_source_branch: false },
    );
    await provider.updateBranch(gitlab, pr);
    expect(api).toHaveBeenLastCalledWith(
      gitlab,
      "PUT",
      "projects/group%2Fsub%2Fapp/merge_requests/9/rebase",
      { skip_ci: false },
    );
    await expect(provider.merge(gitlab, pr, "rebase")).rejects.toThrow(
      /合并方式/,
    );
  });
  it("reuses an existing same-head/base PR rather than reposting after uncertain delivery", async () => {
    const api = vi.fn(async (_r, _m, endpoint) =>
      endpoint.includes("?state=")
        ? [githubRow]
        : endpoint.includes("check-runs")
          ? { check_runs: [] }
          : endpoint.includes("/status")
            ? { statuses: [] }
            : githubRow,
    );
    const provider = new RemotePrProvider(api);
    const pr = await provider.create(github, {
      ...github,
      requestId: "r",
      title: "New",
      body: "desc",
      head: "feature/auth",
      base: "main",
      draft: true,
    });
    expect(pr.number).toBe(7);
    expect(api.mock.calls.some((call) => call[1] === "POST")).toBe(false);
  });
  it("posts explicit draft data to the selected provider and handles pagination", async () => {
    const api = vi.fn(async (_r, method, endpoint) =>
      endpoint.includes("/repository/branches/")
        ? { commit: { id: base } }
        : method === "POST"
          ? gitlabRow
          : endpoint.includes("source_branch=")
            ? []
            : endpoint.includes("page=2")
              ? Array.from({ length: 30 }, () => gitlabRow)
              : gitlabRow,
    );
    const provider = new RemotePrProvider(api);
    await provider.create(gitlab, {
      ...gitlab,
      requestId: "r",
      title: "Fix",
      body: "body",
      head: "feature/auth",
      base: "main",
      draft: true,
    });
    expect(api).toHaveBeenCalledWith(
      gitlab,
      "POST",
      "projects/group%2Fsub%2Fapp/merge_requests",
      {
        title: "Draft: Fix",
        description: "body",
        source_branch: "feature/auth",
        target_branch: "main",
        remove_source_branch: false,
      },
    );
    expect((await provider.list(gitlab, 2)).hasMore).toBe(true);
  });
  it("does not turn a failed status fetch or unconfirmed merge into success", async () => {
    const api = vi.fn(async (_r, method, endpoint) => {
      if (endpoint.includes("check-runs")) throw new Error("unavailable");
      return method === "PUT"
        ? { merged: false, message: "blocked" }
        : githubRow;
    });
    const provider = new RemotePrProvider(api);
    expect((await provider.get(github, 7)).checksError).toBeTruthy();
    await expect(
      provider.merge(
        github,
        { headSha: sha, number: 7 } as RemotePullRequest,
        "merge",
      ),
    ).rejects.toMatchObject({ code: "PR_MERGE_PENDING" });
  });
});
