import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("./origin", () => ({ apiRequest: vi.fn().mockResolvedValue({}) }));
import { apiRequest } from "./origin";
import { gitMrApi } from "./gitMr";
beforeEach(() => vi.clearAllMocks());
describe("local MR client", () => {
  it("encodes identifiers and supplies optimistic versions for mutations", async () => {
    await gitMrApi.action("project/a", "mr/b", "finalize", 7);
    expect(apiRequest).toHaveBeenCalledWith(
      "/api/projects/project%2Fa/git/mr/mr%2Fb/finalize",
      { method: "POST", body: '{"expectedVersion":7}', silent: true },
    );
    await gitMrApi.saveFile("p", "m", "a/b", {
      expectedRevision: "revision",
      content: "resolved\n",
      resolve: true,
    });
    expect(apiRequest).toHaveBeenLastCalledWith(
      "/api/projects/p/git/mr/m/files/a%2Fb",
      {
        method: "PUT",
        body: JSON.stringify({
          expectedRevision: "revision",
          content: "resolved\n",
          resolve: true,
        }),
        silent: true,
      },
    );
  });
  it("preserves ordered sources and preset authorization", async () => {
    const input = {
      title: "merge",
      target: "main",
      sources: ["b", "a"],
      strategy: "merge_commit" as const,
      autoFinalize: true,
      allowCheckedOutTarget: false,
    };
    await gitMrApi.savePreset("p", "weekly", input);
    expect(apiRequest).toHaveBeenCalledWith("/api/projects/p/git/mr/presets", {
      method: "POST",
      body: JSON.stringify({ name: "weekly", input }),
      silent: true,
    });
    await gitMrApi.applyProposal("p", "m", "proposal", 8);
    expect(apiRequest).toHaveBeenLastCalledWith(
      "/api/projects/p/git/mr/m/proposals/proposal/apply",
      { method: "POST", body: '{"expectedVersion":8}', silent: true },
    );
  });
});

it("resumes an interrupted run with the viewed execution version", async () => {
  await gitMrApi.action("p", "interrupted-run", "resume", 12);
  expect(apiRequest).toHaveBeenCalledWith(
    "/api/projects/p/git/mr/interrupted-run/resume",
    {
      method: "POST",
      body: '{"expectedVersion":12}',
      silent: true,
    },
  );
});

it("requests branch ancestry and eligibility without exposing repository paths", async () => {
  const input = {
    rootId: "root",
    target: "feature/target",
    strategy: "ff_only" as const,
    sources: ["feature/a"],
  };
  const controller = new AbortController();
  await gitMrApi.branchOptions("project/a", input, controller.signal);
  expect(apiRequest).toHaveBeenLastCalledWith(
    "/api/projects/project%2Fa/git/mr/branch-options",
    {
      method: "POST",
      body: JSON.stringify(input),
      silent: true,
      signal: controller.signal,
    },
  );
});
