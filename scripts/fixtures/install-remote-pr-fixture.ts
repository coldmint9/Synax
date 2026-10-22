import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
export async function installRemotePrFixture(
  directory: string,
  repository: string,
) {
  const cliDir = path.join(directory, "offline-cli");
  await fs.mkdir(cliDir);
  const git = (...args: string[]) =>
    execFileSync("git", args, { cwd: repository, encoding: "utf8" }).trim();
  const headSha = git("rev-parse", "feature/session-refresh-v2"),
    baseSha = git("rev-parse", "main");
  git("remote", "add", "origin", "https://github.com/synax-fixture/demo.git");
  git("remote", "add", "gitlab", "https://gitlab.com/synax-fixture/demo.git");
  const now = new Date().toISOString();
  const title = "会话刷新 · 远程合并验收";
  await fs.writeFile(
    path.join(cliDir, "state.json"),
    JSON.stringify({
      baseSha,
      github: {
        number: 7,
        title,
        body: "离线验收数据：同时保留会话刷新和密钥轮换。",
        html_url: "https://github.com/synax-fixture/demo/pull/7",
        state: "open",
        draft: false,
        head: {
          ref: "feature/session-refresh-v2",
          sha: headSha,
          repo: { full_name: "synax-fixture/demo" },
        },
        base: {
          ref: "main",
          sha: baseSha,
          repo: { full_name: "synax-fixture/demo" },
        },
        mergeable: true,
        mergeable_state: "clean",
        user: { login: "fixture" },
        updated_at: now,
      },
      gitlab: {
        iid: 7,
        title,
        description: "离线 GitLab 验收数据",
        web_url: "https://gitlab.com/synax-fixture/demo/-/merge_requests/7",
        state: "opened",
        draft: false,
        source_branch: "feature/session-refresh-v2",
        target_branch: "main",
        sha: headSha,
        diff_refs: { start_sha: baseSha },
        source_project_id: 1,
        target_project_id: 1,
        detailed_merge_status: "mergeable",
        author: { username: "fixture" },
        head_pipeline: { id: 42, status: "success" },
        updated_at: now,
      },
    }),
  );
  const cli = await fs.readFile(
    path.resolve("scripts/fixtures/remote-pr-cli.cjs"),
    "utf8",
  );
  for (const name of ["gh", "glab"])
    await fs.writeFile(
      path.join(cliDir, name),
      `#!${process.execPath}\n${cli}`,
      { mode: 0o700 },
    );
  const realGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  await fs.writeFile(
    path.join(cliDir, "git"),
    `#!${process.execPath}\nconst {spawnSync}=require('node:child_process');const args=process.argv.slice(2);if(args.some(a=>a==='push'||a==='fetch')){console.error('Offline UI fixture: remote Git network operations are disabled.');process.exit(1);}const result=spawnSync(${JSON.stringify(realGit)},args,{stdio:'inherit'});process.exit(result.status??1);`,
    { mode: 0o700 },
  );
  return cliDir;
}
