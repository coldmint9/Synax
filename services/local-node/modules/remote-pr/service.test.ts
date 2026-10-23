import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { beforeEach, afterEach, describe, it, expect, vi } from "vitest";
import { RemotePrService } from "./service.js";
import { RemotePrProvider } from "./provider.js";
import { ConversationGitService } from "../agent-runtime/conversation-git/service.js";
import { GitMrService } from "../git-mr/service.js";
import { GitMrStore } from "../git-mr/store.js";
import { git as nativeGit } from "../git-mr/repository.js";
import type {
  RemotePullRequest,
  RemotePrSnapshot,
  RemotePrAction,
} from "./contracts.js";
let dir: string,
  repo: string,
  bare: string,
  pr: RemotePullRequest,
  service: RemotePrService,
  provider: RemotePrProvider,
  store: GitMrStore;
let n = 0;
let localTasks: ConversationGitService;
const git = (...args: string[]) =>
  execFileSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
const request = () => `request-${++n}`;
const attach = () =>
  service.attach("s", {
    remote: "origin",
    rootId: "root",
    number: 7,
    requestId: request(),
  });
const act = (
  s: RemotePrSnapshot,
  action: RemotePrAction["action"],
  extra: Partial<RemotePrAction> = {},
) =>
  service.action("s", s.task.id, {
    action,
    requestId: request(),
    expectedRevision: s.task.revision,
    expectedHeadSha: s.pr.headSha,
    expectedBaseSha: s.pr.baseSha,
    ...extra,
  });
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "synax-remote-pr-"));
  repo = path.join(dir, "repo");
  bare = path.join(dir, "remote.git");
  fs.mkdirSync(repo);
  git("init", "-b", "main");
  git("config", "user.name", "PR test");
  git("config", "user.email", "pr@example.test");
  fs.writeFileSync(path.join(repo, "file.txt"), "base");
  git("add", ".");
  git("commit", "-m", "base");
  const base = git("rev-parse", "HEAD");
  git("checkout", "-b", "feature/auth");
  fs.writeFileSync(path.join(repo, "file.txt"), "source");
  git("commit", "-am", "feature");
  execFileSync("git", ["clone", "--bare", repo, bare], { stdio: "ignore" });
  git("remote", "add", "origin", "https://github.com/acme/app.git");
  pr = {
    number: 7,
    title: "Auth",
    body: "desc",
    url: "https://github.com/acme/app/pull/7",
    state: "open",
    draft: false,
    head: "feature/auth",
    base: "main",
    headSha: git("rev-parse", "HEAD"),
    baseSha: base,
    mergeable: true,
    mergeStatus: "clean",
    author: "mint",
    checks: [{ name: "unit", status: "passed" }],
    sameRepository: true,
    updatedAt: "",
  };
  provider = {
    get: vi.fn(async () => structuredClone(pr)),
    list: vi.fn(async () => ({ items: [structuredClone(pr)], hasMore: false })),
    create: vi.fn(async () => structuredClone(pr)),
    merge: vi.fn(async () => {
      pr.state = "merged";
    }),
    updateBranch: vi.fn(async () => {}),
  } as unknown as RemotePrProvider;
  store = new GitMrStore(path.join(dir, "state"));
  const runtime = {
    getSession: (id: string) => ({ id, projectId: "p" }),
    appendMessage: vi.fn((message: any) => message),
    flushSession: vi.fn(async () => {}),
  } as any;
  localTasks = new ConversationGitService({
    gitMr: new GitMrService(store),
    store,
    runtimeStore: runtime,
    resolveRoots: () => [
      {
        id: "root",
        name: "Repo",
        role: "primary",
        status: "available",
        path: repo,
      },
    ],
    emitMessages: () => {},
  });
  service = new RemotePrService(
    provider,
    store,
    runtime,
    () => ({
      id: "root",
      name: "Repo",
      role: "primary",
      status: "available",
      path: repo,
    }),
    localTasks,
    async (r, args, opts) => {
      const next = [...args];
      if (next[0] === "fetch" || next[0] === "push") {
        const index = next.indexOf("origin");
        if (index >= 0) next[index] = bare;
      }
      return nativeGit(r, next, opts);
    },
  );
}, 60000);
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));
describe(
  "remote PR tasks with real local Git and isolated provider",
  { timeout: 120000 },
  () => {
    it("attaches one persistent card, scopes it to owner, and restores it from disk", async () => {
      const a = await attach(),
        b = await attach();
      expect(a.task.id).toBe(b.task.id);
      expect(a.reference.schema).toBe("synax.git-pr");
      expect(a.messages).toHaveLength(1);
      expect((await service.get("s", a.task.id)).task.id).toBe(a.task.id);
      await expect(service.get("other", a.task.id)).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      git("remote", "set-url", "origin", "https://github.com/other/repo.git");
      await expect(service.get("s", a.task.id)).rejects.toMatchObject({
        code: "PR_SCOPE_CHANGED",
      });
    });
    it("rejects stale heads and revisions before remote mutations", async () => {
      const task = await attach();
      await expect(
        act(task, "merge", { expectedRevision: 42 }),
      ).rejects.toMatchObject({ code: "STALE_VERSION" });
      pr.headSha = "c".repeat(40);
      await expect(act(task, "merge")).rejects.toMatchObject({
        code: "STALE_VERSION",
      });
      expect(provider.merge).not.toHaveBeenCalled();
    });
    it("blocks failed checks, drafts and fork synchronization", async () => {
      const task = await attach();
      pr.checks = [{ name: "unit", status: "failed" }];
      await expect(act(task, "merge")).rejects.toMatchObject({
        code: "PR_CHECKS_PENDING",
      });
      pr.checks = [];
      pr.draft = true;
      await expect(act(task, "merge")).rejects.toMatchObject({
        code: "PR_NOT_READY",
      });
      pr.draft = false;
      pr.sameRepository = false;
      await expect(act(task, "update_branch")).rejects.toMatchObject({
        code: "PR_FORK_SYNC",
      });
    });
    it("does not repeat a confirmed remote merge for duplicate requests", async () => {
      const task = await attach();
      const requestId = request();
      const merged = await act(task, "merge", { requestId });
      expect(merged.pr.state).toBe("merged");
      expect(merged.messages.at(-1)?.metadata.operation).toBe("merge");
      expect((await act(task, "merge", { requestId })).pr.state).toBe("merged");
      expect(provider.merge).toHaveBeenCalledTimes(1);
      await expect(
        act(task, "update_branch", { requestId }),
      ).rejects.toMatchObject({ code: "IDEMPOTENCY_CONFLICT" });
    });
    it("only fast forwards a clean matching local branch", async () => {
      const task = await attach();
      git("reset", "--hard", "main");
      const synced = await act(task, "sync_local");
      expect(git("rev-parse", "HEAD")).toBe(pr.headSha);
      expect(synced.messages.at(-1)?.content).toContain("快进");
      fs.writeFileSync(path.join(repo, "dirty.txt"), "dirty");
      await expect(act(synced, "sync_local")).rejects.toMatchObject({
        code: "DIRTY_WORKTREE",
      });
    });
    it("syncs the target branch after a remote merge without switching the user's branch", async () => {
    const task = await attach();
    git('push', bare, 'feature/auth:refs/heads/main');
    pr.state = 'merged'; pr.baseSha = pr.headSha;
    git('checkout', 'main');
    const fresh = await service.get('s', task.task.id);
    const result = await act(fresh, 'sync_local');
    expect(git('branch', '--show-current')).toBe('main');
    expect(git('rev-parse', 'HEAD')).toBe(pr.baseSha);
    expect(result.messages.at(-1)?.content).toContain('main');
  });
  it("pushes the explicitly reviewed current HEAD without force", async () => {
      const state = await service.discover("s", "root");
      fs.writeFileSync(path.join(repo, "new.txt"), "new");
      git("add", ".");
      git("commit", "-m", "new");
      await expect(
        service.push("s", {
          remote: "origin",
          rootId: "root",
          branch: state.branch,
          expectedLocalHead: state.headSha,
        }),
      ).rejects.toMatchObject({ code: "STALE_VERSION" });
      const next = await service.discover("s", "root");
      await service.push("s", {
        remote: "origin",
        rootId: "root",
        branch: next.branch,
        expectedLocalHead: next.headSha,
      });
      expect(
        execFileSync(
          "git",
          ["--git-dir", bare, "rev-parse", "refs/heads/feature/auth"],
          { encoding: "utf8" },
        ).trim(),
      ).toBe(next.headSha);
      git(
        "remote",
        "set-url",
        "--push",
        "origin",
        "https://github.com/other/app.git",
      );
      await expect(
        service.push("s", {
          remote: "origin",
          rootId: "root",
          branch: next.branch,
          expectedLocalHead: next.headSha,
        }),
      ).rejects.toMatchObject({ code: "PR_PUSH_REMOTE_MISMATCH" });
    });

    it("resolves a remote conflict through the existing isolated local task and pushes only after explicit publication", async () => {
      git("checkout", "main");
      fs.writeFileSync(path.join(repo, "file.txt"), "target");
      git("commit", "-am", "target");
      git("push", bare, "main");
      git("checkout", "feature/auth");
      pr.baseSha = git("rev-parse", "main");
      pr.mergeable = false;
      let snapshot = await attach();
      snapshot = await act(snapshot, "resolve_conflicts");
      expect(snapshot.resolutionReference).toBeTruthy();
      let local = await localTasks.get(
        "s",
        snapshot.resolutionReference!.objectId,
      );
      expect(local.mr.status).toBe("conflicted");
      const file = await localTasks.file(
        "s",
        local.task.id,
        local.files.find((f) => f.conflicted)!.id,
      );
      local = await localTasks.saveFile("s", local.task.id, file.id, {
        requestId: request(),
        expectedVersion: local.mr.version,
        expectedTaskRevision: local.task.revision,
        expectedRevision: file.revision,
        content: "target + source",
        resolve: true,
      });
      local = await localTasks.action("s", local.task.id, {
        action: "continue",
        requestId: request(),
        expectedVersion: local.mr.version,
        expectedTaskRevision: local.task.revision,
      });
      local = await localTasks.action("s", local.task.id, {
        action: "finalize",
        requestId: request(),
        expectedVersion: local.mr.version,
        expectedTaskRevision: local.task.revision,
      });
      expect(
        execFileSync(
          "git",
          ["--git-dir", bare, "rev-parse", "refs/heads/feature/auth"],
          { encoding: "utf8" },
        ).trim(),
      ).toBe(pr.headSha);
      snapshot = await act(snapshot, "publish_resolution");
      expect(
        execFileSync(
          "git",
          ["--git-dir", bare, "rev-parse", "refs/heads/feature/auth"],
          { encoding: "utf8" },
        ).trim(),
      ).toBe(local.mr.candidateOid);
      expect(snapshot.messages.at(-1)?.metadata.operation).toBe(
        "publish_resolution",
      );
    });
    it("keeps uncertain network outcomes pending instead of blindly replaying writes", async () => {
      const task = await attach();
      vi.mocked(provider.updateBranch).mockRejectedValue(
        new Error("response lost"),
      );
      const requestId = request();
      await expect(act(task, "update_branch", { requestId })).rejects.toThrow(
        "response lost",
      );
      await expect(
        act(task, "update_branch", { requestId }),
      ).rejects.toMatchObject({ code: "PR_UNCERTAIN" });
      expect(provider.updateBranch).toHaveBeenCalledTimes(1);
    });
  },
);
