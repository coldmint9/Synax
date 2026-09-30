import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, renameSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { gitHistoryPage, gitCommitDetail } from "../git-workspaces.js";
let root: string;
const git = (...args: string[]) => execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
beforeEach(() => {
  root = mkdtempSync(path.join(os.tmpdir(), "synax-history-"));
  git("init", "-b", "main"); git("config", "user.name", "Test Author"); git("config", "user.email", "test@example.com");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
describe("history pages", () => {
  it("returns an empty page for an unborn repository", async () => {
    expect((await gitHistoryPage(root)).commits).toEqual([]);
  });
  it("pages beyond 180 commits including remote-only commits, and rejects changed refs", async () => {
    for (let i = 0; i < 185; i++) git("commit", "--allow-empty", "-m", `commit ${i}`);
    git("checkout", "-b", "remote-source"); git("commit", "--allow-empty", "-m", "remote only");
    const remote = git("rev-parse", "HEAD");
    git("update-ref", "refs/remotes/origin/topic", remote);
    git("checkout", "main"); git("branch", "-D", "remote-source");
    const first = await gitHistoryPage(root, { limit: 100 });
    const second = await gitHistoryPage(root, { offset: first.nextOffset!, snapshot: first.snapshot, limit: 100 });
    expect(first.refs).toContainEqual(expect.objectContaining({ fullName: "refs/remotes/origin/topic", kind: "remote" }));
    const commits = [...first.commits, ...second.commits];
    expect(commits).toHaveLength(186);
    expect(new Set(commits.map(c => c.id)).size).toBe(186);
    expect(commits.find(c => c.id === remote)?.subject).toBe("remote only");
    expect(second.nextOffset).toBeNull();
    git("commit", "--allow-empty", "-m", "new commit");
    await expect(gitHistoryPage(root, { offset: 100, snapshot: first.snapshot })).rejects.toMatchObject({ status: 409 });
  }, 60000);
  it("reports full message and rename paths including whitespace", async () => {
    writeFileSync(path.join(root, "before name.txt"), "hello\n");
    git("add", "."); git("commit", "-m", "initial");
    renameSync(path.join(root, "before name.txt"), path.join(root, "after name.txt"));
    git("add", "-A"); git("commit", "-m", "rename\n\nFull description");
    const detail = await gitCommitDetail(root, git("rev-parse", "HEAD"));
    expect(detail.message).toContain("Full description");
    expect(detail.authorEmail).toBe("test@example.com");
    expect(detail.files).toEqual([{ status: "R100", previousPath: "before name.txt", path: "after name.txt" }]);
    expect(detail.diff).toContain("rename from before name.txt");
  });
});
