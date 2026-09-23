import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, describe, expect, it } from "vitest";
import { inspectMergeBranches } from "../branch-options.js";
import { GitMrService } from "../service.js";
import { GitMrStore } from "../store.js";
let directory: string;
const git = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: directory,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
function commit(text: string) {
  fs.writeFileSync(path.join(directory, "app.txt"), text);
  git("add", "app.txt");
  git("commit", "-m", text);
}
function branch(name: string, base = "main", text = name) {
  git("checkout", "-b", name, base);
  commit(text);
  git("checkout", "main");
}
async function options(
  target = "main",
  strategy: "merge_commit" | "ff_only" | "squash" = "merge_commit",
  sources: string[] = [],
) {
  return inspectMergeBranches(
    { kind: "host", path: directory },
    { target, strategy, sources },
  );
}
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "synax-branch-options-"));
  git("init", "-b", "main");
  git("config", "user.email", "test@example.test");
  git("config", "user.name", "Test");
  commit("base");
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
describe("branch picker eligibility from real Git", { timeout: 30000 }, () => {
  it("shows verifiable creation ancestor and disables target/already included branches", async () => {
    const base = git("rev-parse", "main");
    git("branch", "already", "main");
    branch("feature/a");
    const result = await options();
    expect(result.branches.find((item) => item.name === "main")).toMatchObject({
      enabled: false,
      reason: "same_branch",
    });
    expect(
      result.branches.find((item) => item.name === "already"),
    ).toMatchObject({ enabled: false, reason: "already_included" });
    expect(
      result.branches.find((item) => item.name === "feature/a"),
    ).toMatchObject({
      enabled: true,
      ancestor: { branch: "main", oid: base, evidence: "creation_record" },
    });
  });
  it("does not disable resolvable textual conflicts; disables divergent FF", async () => {
    branch("feature/a");
    commit("target change");
    expect(
      (await options()).branches.find((item) => item.name === "feature/a")
        ?.enabled,
    ).toBe(true);
    expect(
      (await options("main", "ff_only")).branches.find(
        (item) => item.name === "feature/a",
      ),
    ).toMatchObject({ enabled: false, reason: "not_fast_forward" });
  });
  it("disables direct and indirect test/beta history with same policy as actual creation", async () => {
    branch("beta");
    git("branch", "feature/indirect", "beta");
    branch("feature/target");
    branch("feature/clean");
    const result = await options("feature/target");
    for (const name of ["beta", "feature/indirect"])
      expect(result.branches.find((item) => item.name === name)).toMatchObject({
        enabled: false,
        reason: "branch_policy",
      });
    expect(
      result.branches.find((item) => item.name === "feature/clean")?.enabled,
    ).toBe(true);
    const service = new GitMrService(
      new GitMrStore(path.join(directory, ".git", "records")),
    );
    await expect(
      service.create(
        "p",
        { kind: "host", path: directory },
        {
          title: "blocked",
          target: "feature/target",
          sources: ["feature/indirect"],
          strategy: "merge_commit",
        },
      ),
    ).rejects.toMatchObject({ code: "BRANCH_POLICY" });
  });
  it("reports merge-base evidence when the creation source was only HEAD", async () => {
    git("checkout", "-b", "feature/head");
    commit("head change");
    git("checkout", "main");
    const original = git("rev-parse", "main");
    commit("new production commit");
    const item = (await options()).branches.find(
      (item) => item.name === "feature/head",
    )!;
    expect(item.ancestor).toEqual({
      branch: "main",
      oid: original,
      evidence: "merge_base",
    });
  });
  it("leaves ancestry unknown when reflog and production baseline are unavailable", async () => {
    git("branch", "release", "main");
    git("checkout", "release");
    git("branch", "-D", "main");
    git("checkout", "-b", "feature/unknown");
    commit("unknown");
    git("checkout", "release");
    const item = (await options("release")).branches.find(
      (item) => item.name === "feature/unknown",
    )!;
    expect(item.ancestor.evidence).toBe("unknown");
  });
  it("rejects unrelated histories without guessing an ancestor", async () => {
    git("checkout", "--orphan", "unrelated");
    git("rm", "-rf", ".");
    commit("orphan");
    git("checkout", "main");
    const item = (await options()).branches.find(
      (item) => item.name === "unrelated",
    );
    expect(item).toMatchObject({
      enabled: false,
      reason: "unrelated_histories",
      ancestor: { evidence: "unknown" },
    });
  });
  it("evaluates FF candidates against the last valid selected source, and flags invalid reordered selections", async () => {
    branch("feature/a");
    branch("feature/b", "feature/a");
    branch("feature/diverged");
    const result = await options("main", "ff_only", ["feature/a"]);
    expect(result.comparisonBranch).toBe("feature/a");
    expect(
      result.branches.find((item) => item.name === "feature/b")?.enabled,
    ).toBe(true);
    expect(
      result.branches.find((item) => item.name === "feature/diverged"),
    ).toMatchObject({ enabled: false, reason: "not_fast_forward" });
    expect(
      (await options("main", "ff_only", ["feature/b", "feature/a"]))
        .invalidSources,
    ).toEqual([
      expect.objectContaining({
        name: "feature/a",
        reason: "already_included",
      }),
    ]);
  });
});
