import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GitMrService } from "../service.js";
import { GitMrStore } from "../store.js";
import type { MergeRequestInput, MergeRequest } from "../contracts.js";
let directory: string, repo: string, service: GitMrService;
const git = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
function commit(file: string, text: string) {
  fs.writeFileSync(path.join(repo, file), text);
  git("--literal-pathspecs", "add", "--", file);
  git("commit", "-m", file);
}
function source(name: string, file: string, text: string) {
  git("checkout", "-b", name, "main");
  commit(file, text);
  git("checkout", "main");
}
async function create(overrides: Partial<MergeRequestInput> = {}) {
  return service.create(
    "project",
    { kind: "host", path: repo },
    {
      title: "Integration",
      target: "integration",
      sources: ["feature/a"],
      strategy: "merge_commit",
      ...overrides,
    },
  );
}
const latest = (mr: MergeRequest) => service.get("project", mr.id);
beforeEach(() => {
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "synax-mr-"));
  repo = path.join(directory, "repo");
  fs.mkdirSync(repo);
  git("init", "-b", "main");
  git("config", "user.name", "Test");
  git("config", "user.email", "test@example.test");
  commit("app.ts", "export const x = 1;\n");
  git("branch", "integration");
  source("feature/a", "a.ts", "export const a = 1;\n");
  service = new GitMrService(new GitMrStore(path.join(directory, "state")));
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));
describe("local merge requests (real git)", { timeout: 60000 }, () => {
  it("prepares a merge without changing target or source and publishes with two parents", async () => {
    const target = git("rev-parse", "integration"),
      source = git("rev-parse", "feature/a");
    let mr = await create();
    mr = await service.prepare("project", mr.id, mr.version);
    expect(mr.status).toBe("ready");
    expect(git("rev-parse", "integration")).toBe(target);
    expect(git("rev-parse", "feature/a")).toBe(source);
    mr = await service.finalize("project", mr.id, mr.version);
    expect(mr.status).toBe("merged");
    expect(git("rev-parse", "integration")).toBe(mr.candidateOid);
    expect(git("show", "-s", "--format=%P", "integration").split(" ")).toEqual([
      target,
      source,
    ]);
  });
  it("squashes into a single-parent commit", async () => {
    let mr = await create({ strategy: "squash" });
    mr = await service.prepare("project", mr.id, mr.version);
    mr = await service.finalize("project", mr.id, mr.version);
    expect(
      git("show", "-s", "--format=%P", "integration").split(" "),
    ).toHaveLength(1);
    expect(git("show", "integration:a.ts")).toContain("const a");
  });
  it("fast-forwards and marks already included sources as noop", async () => {
    let mr = await create({ strategy: "ff_only" });
    mr = await service.prepare("project", mr.id, mr.version);
    expect(mr.candidateOid).toBe(git("rev-parse", "feature/a"));
    mr = await service.finalize("project", mr.id, mr.version);
    let repeat = await create();
    repeat = await service.prepare("project", repeat.id, repeat.version);
    expect(repeat.status).toBe("noop");
  });
  it("keeps target unchanged when second batch source conflicts, rejects stale drafts, resumes cumulatively", async () => {
    source("feature/b", "a.ts", "export const a = 2;\n");
    const target = git("rev-parse", "integration");
    let mr = await create({ sources: ["feature/a", "feature/b"] });
    mr = await service.prepare("project", mr.id, mr.version);
    expect(mr.status).toBe("conflicted");
    expect(mr.steps[0].status).toBe("completed");
    expect(git("rev-parse", "integration")).toBe(target);
    const files = await service.files("project", mr.id);
    const file = await service.file(
      "project",
      mr.id,
      files.find((file) => file.conflicted)!.id,
    );
    expect(file.result).toContain("<<<<<<<");
    const draft = await service.saveFile("project", mr.id, file.id, {
      expectedRevision: file.revision,
      content: "export const a = 3;\n",
      resolve: false,
    });
    await expect(
      service.saveFile("project", mr.id, file.id, {
        expectedRevision: file.revision,
        content: "bad",
        resolve: true,
      }),
    ).rejects.toMatchObject({ code: "STALE_DRAFT" });
    await service.saveFile("project", mr.id, file.id, {
      expectedRevision: draft.revision,
      content: draft.result,
      resolve: true,
    });
    mr = await latest(mr);
    mr = await service.continue("project", mr.id, mr.version);
    expect(mr.status).toBe("ready");
    mr = await service.finalize("project", mr.id, mr.version);
    expect(git("show", "integration:a.ts")).toContain("a = 3");
  });
  it("refuses marker-containing resolutions and continuing with unmerged index", async () => {
    source("feature/b", "a.ts", "different\n");
    let mr = await create({ sources: ["feature/a", "feature/b"] });
    mr = await service.prepare("project", mr.id, mr.version);
    const file = await service.file(
      "project",
      mr.id,
      (await service.files("project", mr.id)).find((file) => file.conflicted)!
        .id,
    );
    await expect(
      service.saveFile("project", mr.id, file.id, {
        expectedRevision: file.revision,
        content: file.result,
        resolve: true,
      }),
    ).rejects.toMatchObject({ code: "UNRESOLVED_CONTENT" });
    await expect(
      service.continue("project", mr.id, mr.version),
    ).rejects.toMatchObject({ code: "UNRESOLVED_CONFLICTS" });
  });
  it("rejects stale target and source without modifying either", async () => {
    let mr = await create();
    mr = await service.prepare("project", mr.id, mr.version);
    git("update-ref", "refs/heads/integration", git("rev-parse", "feature/a"));
    await expect(
      service.finalize("project", mr.id, mr.version),
    ).rejects.toMatchObject({ code: "STALE_PLAN" });
  });
  it("rejects a moved source snapshot", async () => {
    let mr = await create();
    mr = await service.prepare("project", mr.id, mr.version);
    git("checkout", "feature/a");
    commit("later.ts", "later");
    git("checkout", "main");
    await expect(
      service.finalize("project", mr.id, mr.version),
    ).rejects.toMatchObject({ code: "STALE_PLAN" });
  });
  it("does not silently update a checked-out target; opted-in apply updates index and disk", async () => {
    let mr = await create({ target: "main" });
    mr = await service.prepare("project", mr.id, mr.version);
    await expect(
      service.finalize("project", mr.id, mr.version),
    ).rejects.toMatchObject({ code: "TARGET_BUSY" });
    let approved = await create({
      target: "main",
      allowCheckedOutTarget: true,
    });
    approved = await service.prepare("project", approved.id, approved.version);
    approved = await service.finalize("project", approved.id, approved.version);
    expect(approved.status).toBe("merged");
    expect(fs.readFileSync(path.join(repo, "a.ts"), "utf8")).toContain("a = 1");
    expect(git("status", "--porcelain")).toBe("");
  });
  it("never overwrites dirty target files", async () => {
    let mr = await create({ target: "main", allowCheckedOutTarget: true });
    mr = await service.prepare("project", mr.id, mr.version);
    fs.writeFileSync(path.join(repo, "app.ts"), "user draft");
    await expect(
      service.finalize("project", mr.id, mr.version),
    ).rejects.toMatchObject({ code: "DIRTY_WORKTREE" });
    expect(fs.readFileSync(path.join(repo, "app.ts"), "utf8")).toBe(
      "user draft",
    );
  });
  it("blocks OS metadata and test/beta entering feature including indirect ancestry", async () => {
    source("test", "test-only.ts", "test");
    git("branch", "feature/target", "main");
    await expect(
      create({ target: "feature/target", sources: ["test"] }),
    ).rejects.toMatchObject({ code: "BRANCH_POLICY" });
    git("branch", "feature/indirect", "test");
    await expect(
      create({ target: "feature/target", sources: ["feature/indirect"] }),
    ).rejects.toMatchObject({ code: "BRANCH_POLICY" });
    source("feature/os", ".DS_Store", "metadata");
    const mr = await create({ sources: ["feature/os"] });
    await expect(
      service.prepare("project", mr.id, mr.version),
    ).rejects.toMatchObject({ code: "BRANCH_POLICY" });
  });
  it("requires all configured checks and binds results to candidate", async () => {
    let mr = await create({
      checks: [
        {
          id: "unit",
          executable: process.execPath,
          args: ["-e", "process.exit(0)"],
          timeoutMs: 5000,
        },
      ],
    });
    mr = await service.prepare("project", mr.id, mr.version);
    await expect(
      service.finalize("project", mr.id, mr.version),
    ).rejects.toMatchObject({ code: "CHECKS_REQUIRED" });
    mr = await latest(mr);
    mr = await service.checks("project", mr.id, mr.version);
    expect(mr.checkResults[0].tree).toBe(mr.candidateTree);
    mr = await service.finalize("project", mr.id, mr.version);
    expect(mr.status).toBe("merged");
  });
  it("a failed check prevents automatic publishing and retains target", async () => {
    const original = git("rev-parse", "integration");
    let mr = await create({
      autoFinalize: true,
      checks: [
        {
          id: "unit",
          executable: process.execPath,
          args: ["-e", "process.exit(1)"],
          timeoutMs: 5000,
        },
      ],
    });
    mr = await service.prepare("project", mr.id, mr.version);
    expect(mr.status).toBe("check_failed");
    expect(git("rev-parse", "integration")).toBe(original);
  });
  it("detects checks mutating the candidate worktree", async () => {
    let mr = await create({
      checks: [
        {
          id: "mutating",
          executable: process.execPath,
          args: ["-e", "require('fs').writeFileSync('app.ts','changed')"],
          timeoutMs: 5000,
        },
      ],
    });
    mr = await service.prepare("project", mr.id, mr.version);
    await expect(
      service.checks("project", mr.id, mr.version),
    ).rejects.toMatchObject({ code: "DIRTY_WORKTREE" });
    expect((await latest(mr)).status).toBe("failed");
  });
  it("presets execute real snapshots and persist across service instances", async () => {
    const preset = await service.savePreset("project", "one click", {
      title: "preset",
      target: "integration",
      sources: ["feature/a"],
      strategy: "merge_commit",
      autoFinalize: true,
      checks: [
        {
          id: "check",
          executable: process.execPath,
          args: ["-e", "process.exit(0)"],
          timeoutMs: 5000,
        },
      ],
    });
    const mr = await service.runPreset("project", preset.id, {
      kind: "host",
      path: repo,
    });
    expect(mr.status).toBe("merged");
    const other = new GitMrService(
      new GitMrStore(path.join(directory, "state")),
    );
    expect((await other.get("project", mr.id)).status).toBe("merged");
    expect(await other.presets("project")).toHaveLength(1);
  });
  it("isolates project records and serializes separate service instances", async () => {
    const mr = await create();
    await expect(service.get("other", mr.id)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await service.store.exclusive(mr.commonDir, async () => {
      const other = new GitMrService(
        new GitMrStore(path.join(directory, "state")),
      );
      await expect(
        other.prepare("project", mr.id, mr.version),
      ).rejects.toMatchObject({ code: "REPOSITORY_BUSY" });
    });
  });
  it("stale versions and invalid branch names cannot start writes", async () => {
    const mr = await create();
    await expect(service.prepare("project", mr.id, 99)).rejects.toMatchObject({
      code: "STALE_VERSION",
    });
    await expect(
      create({ sources: ["--upload-pack=bad"] }),
    ).rejects.toMatchObject({ code: "INVALID_BRANCH" });
    await expect(
      create({ sources: ["feature/a", "feature/a"] }),
    ).rejects.toMatchObject({ code: "INVALID_BRANCHES" });
  });
  it("cancel retains isolated conflict drafts and leaves target unchanged", async () => {
    source("feature/b", "a.ts", "different");
    let mr = await create({ sources: ["feature/a", "feature/b"] });
    mr = await service.prepare("project", mr.id, mr.version);
    mr = await service.cancel("project", mr.id, mr.version);
    expect(mr.status).toBe("cancelled");
    expect(fs.existsSync(mr.worktree!)).toBe(true);
    expect(git("rev-parse", "integration")).toBe(mr.targetOid);
  });
  it("AI proposals are never applied without explicit accept and reject changed draft", async () => {
    source("feature/b", "a.ts", "different");
    let mr = await create({ sources: ["feature/a", "feature/b"] });
    mr = await service.prepare("project", mr.id, mr.version);
    const file = await service.file(
      "project",
      mr.id,
      (await service.files("project", mr.id)).find((file) => file.conflicted)!
        .id,
    );
    const proposal = await service.propose("project", mr.id, {
      fileId: file.id,
      revision: file.revision,
      content: "proposed",
      rationale: "combine",
    });
    expect((await service.file("project", mr.id, file.id)).result).toBe(
      file.result,
    );
    await service.saveFile("project", mr.id, file.id, {
      expectedRevision: file.revision,
      content: "human",
      resolve: false,
    });
    mr = await latest(mr);
    await expect(
      service.applyProposal("project", mr.id, proposal.id, mr.version),
    ).rejects.toMatchObject({ code: "STALE_DRAFT" });
  });
});

describe(
  "recovery and persisted conflict decisions",
  { timeout: 60000 },
  () => {
    it("restores a ready candidate after an interrupted check without inventing check success", async () => {
      let mr = await create();
      mr = await service.prepare("project", mr.id, mr.version);
      mr.status = "checking";
      await service.store.save(mr);
      mr = await service.resume("project", mr.id, mr.version);
      expect(mr.status).toBe("ready");
      expect(mr.checkResults).toEqual([]);
      expect(git("rev-parse", "integration")).toBe(mr.targetOid);
    });
    it("reconciles actual successful target application after a crash before recording it", async () => {
      let mr = await create();
      mr = await service.prepare("project", mr.id, mr.version);
      git("update-ref", "refs/heads/integration", mr.candidateOid!);
      mr.application = {
        candidateOid: mr.candidateOid!,
        targetOid: mr.targetOid,
        startedAt: new Date().toISOString(),
      };
      mr.status = "applying";
      await service.store.save(mr);
      mr = await service.resume("project", mr.id, mr.version);
      expect(mr.status).toBe("merged");
    });
    it("preserves human row decisions on reopen only for identical content", async () => {
      source("feature/b", "a.ts", "different");
      let mr = await create({ sources: ["feature/a", "feature/b"] });
      mr = await service.prepare("project", mr.id, mr.version);
      const file = await service.file(
        "project",
        mr.id,
        (await service.files("project", mr.id)).find((file) => file.conflicted)!
          .id,
      );
      const state = { version: 1, decisions: [{ id: "a", choice: "target" }] };
      await service.saveFile("project", mr.id, file.id, {
        expectedRevision: file.revision,
        content: "human draft",
        resolve: false,
        resolutionState: state,
      });
      expect(
        (await service.file("project", mr.id, file.id)).resolutionState,
      ).toEqual(state);
      fs.writeFileSync(path.join(mr.worktree!, file.path), "external edit");
      expect(
        (await service.file("project", mr.id, file.id)).resolutionState,
      ).toBeUndefined();
    });
    it("resumes a conflict after interruption without losing unmerged entries", async () => {
      source("feature/b", "a.ts", "different");
      let mr = await create({ sources: ["feature/a", "feature/b"] });
      mr = await service.prepare("project", mr.id, mr.version);
      mr.status = "interrupted";
      await service.store.save(mr);
      mr = await service.resume("project", mr.id, mr.version);
      expect(mr.status).toBe("conflicted");
      expect(
        (await service.files("project", mr.id)).some((file) => file.conflicted),
      ).toBe(true);
    });
    it("executes checks without inheriting API credentials or Git path overrides", async () => {
      let mr = await create({
        checks: [
          {
            id: "environment",
            executable: process.execPath,
            args: [
              "-e",
              "process.exit(process.env.SYNAX_MR_TEST_SECRET ? 1 : 0)",
            ],
            timeoutMs: 5000,
          },
        ],
      });
      mr = await service.prepare("project", mr.id, mr.version);
      process.env.SYNAX_MR_TEST_SECRET = "not-for-checks";
      try {
        mr = await service.checks("project", mr.id, mr.version);
        expect(mr.checkResults[0].status).toBe("passed");
      } finally {
        delete process.env.SYNAX_MR_TEST_SECRET;
      }
    });
  },
);

describe("non-text and unusual conflict paths", { timeout: 60000 }, () => {
  it("accepts a binary side without decoding or corrupting bytes", async () => {
    git("checkout", "feature/a");
    fs.writeFileSync(path.join(repo, "image.bin"), Buffer.from([0, 255, 1, 2]));
    git("add", "image.bin");
    git("commit", "-m", "binary a");
    git("checkout", "-b", "feature/b", "main");
    fs.writeFileSync(path.join(repo, "image.bin"), Buffer.from([0, 254, 3, 4]));
    git("add", "image.bin");
    git("commit", "-m", "binary b");
    git("checkout", "main");
    let mr = await create({ sources: ["feature/a", "feature/b"] });
    mr = await service.prepare("project", mr.id, mr.version);
    const file = await service.file(
      "project",
      mr.id,
      (await service.files("project", mr.id)).find(
        (file) => file.path === "image.bin",
      )!.id,
    );
    expect(file.kind).toBe("binary");
    await service.saveFile("project", mr.id, file.id, {
      expectedRevision: file.revision,
      choice: "source",
      resolve: true,
    });
    mr = await latest(mr);
    mr = await service.continue("project", mr.id, mr.version);
    expect(fs.readFileSync(path.join(mr.worktree!, "image.bin"))).toEqual(
      Buffer.from([0, 254, 3, 4]),
    );
  });
  it("handles newline and pathspec-like file names literally", async () => {
    const name = ":(glob) a\nb.txt";
    source("feature/weird1", name, "left");
    source("feature/weird2", name, "right");
    let mr = await create({ sources: ["feature/weird1", "feature/weird2"] });
    mr = await service.prepare("project", mr.id, mr.version);
    const summary = (await service.files("project", mr.id)).find(
      (file) => file.path === name,
    )!;
    expect(summary.conflicted).toBe(true);
    const file = await service.file("project", mr.id, summary.id);
    await service.saveFile("project", mr.id, file.id, {
      expectedRevision: file.revision,
      content: "combined",
      resolve: true,
    });
    mr = await latest(mr);
    mr = await service.continue("project", mr.id, mr.version);
    expect(fs.readFileSync(path.join(mr.worktree!, name), "utf8")).toBe(
      "combined",
    );
  });
  it("never follows a conflict symlink to edit an external file", async () => {
    const external = path.join(directory, "outside");
    fs.writeFileSync(external, "untouched");
    git("checkout", "feature/a");
    fs.symlinkSync(external, path.join(repo, "link"));
    git("add", "link");
    git("commit", "-m", "link a");
    git("checkout", "-b", "feature/b", "main");
    fs.symlinkSync("another", path.join(repo, "link"));
    git("add", "link");
    git("commit", "-m", "link b");
    git("checkout", "main");
    let mr = await create({ sources: ["feature/a", "feature/b"] });
    mr = await service.prepare("project", mr.id, mr.version);
    const file = await service.file(
      "project",
      mr.id,
      (await service.files("project", mr.id)).find(
        (file) => file.path === "link",
      )!.id,
    );
    expect(file.kind).toBe("structural");
    await expect(
      service.saveFile("project", mr.id, file.id, {
        expectedRevision: file.revision,
        content: "bad",
        resolve: true,
      }),
    ).rejects.toMatchObject({ code: "UNSUPPORTED_CONFLICT" });
    expect(fs.readFileSync(external, "utf8")).toBe("untouched");
  });
});

describe(
  "publication race and decision concurrency regressions",
  { timeout: 60000 },
  () => {
    it("does not publish into another branch checked out at the same OID", async () => {
      git("branch", "other", "main");
      const original = git("rev-parse", "other");
      service = new GitMrService(service.store, async () => {
        git("checkout", "other");
        return false;
      });
      let mr = await create({ target: "main", allowCheckedOutTarget: true });
      mr = await service.prepare("project", mr.id, mr.version);
      await expect(
        service.finalize("project", mr.id, mr.version),
      ).rejects.toMatchObject({ code: "TARGET_BUSY" });
      expect(git("rev-parse", "other")).toBe(original);
      expect(git("rev-parse", "main")).toBe(original);
    });
    it("cancelling after an empty squash step does not claim target publication", async () => {
      git("checkout", "-b", "feature/empty", "main");
      git("commit", "--allow-empty", "-m", "empty");
      git("checkout", "main");
      source("feature/conflict", "app.ts", "conflicting");
      git("checkout", "integration");
      commit("app.ts", "target change");
      git("checkout", "main");
      let mr = await create({
        strategy: "squash",
        sources: ["feature/empty", "feature/conflict"],
      });
      mr = await service.prepare("project", mr.id, mr.version);
      expect(mr.currentStep).toBe(1);
      expect(mr.candidateOid).toBe(mr.targetOid);
      mr = await service.cancel("project", mr.id, mr.version);
      expect(mr.status).toBe("cancelled");
    });
    it("same-text saves still invalidate stale row decisions", async () => {
      source("feature/b", "a.ts", "different");
      let mr = await create({ sources: ["feature/a", "feature/b"] });
      mr = await service.prepare("project", mr.id, mr.version);
      const file = await service.file(
        "project",
        mr.id,
        (await service.files("project", mr.id)).find((file) => file.conflicted)!
          .id,
      );
      const fresh = await service.saveFile("project", mr.id, file.id, {
        expectedRevision: file.revision,
        content: file.result,
        resolve: false,
        resolutionState: { decision: "A" },
      });
      expect(fresh.revision).not.toBe(file.revision);
      await expect(
        service.saveFile("project", mr.id, file.id, {
          expectedRevision: file.revision,
          content: file.result,
          resolve: false,
          resolutionState: { decision: "B" },
        }),
      ).rejects.toMatchObject({ code: "STALE_DRAFT" });
      expect(
        (await service.file("project", mr.id, file.id)).resolutionState,
      ).toEqual({ decision: "A" });
    });
  },
);
