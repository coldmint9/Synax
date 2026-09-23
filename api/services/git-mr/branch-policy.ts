import { git, type Repo } from "./repository.js";

/** The same policy is used by admission, finalization and the branch picker. */
export async function loadSourcePolicy(repo: Repo, target: string) {
  const feature = /^(feature(?:\/|$)|codex\/)/.test(target);
  if (!feature)
    return async (_name: string, _oid: string): Promise<string | undefined> =>
      undefined;
  let production: string | undefined;
  for (const name of ["master", "main"]) {
    const ref = await git(
      repo,
      ["rev-parse", "--verify", `refs/heads/${name}`],
      { allowFailure: true },
    );
    if (ref.status === 0) {
      production = ref.stdout.trim();
      break;
    }
  }
  const forbidden = new Set<string>();
  if (production)
    for (const branch of ["test", "beta"]) {
      const ref = await git(
        repo,
        ["rev-parse", "--verify", `refs/heads/${branch}`],
        { allowFailure: true },
      );
      if (ref.status !== 0) continue;
      (
        await git(repo, ["rev-list", ref.stdout.trim(), "--not", production])
      ).stdout
        .split("\n")
        .filter(Boolean)
        .forEach((oid) => forbidden.add(oid));
    }
  return async (name: string, oid: string): Promise<string | undefined> => {
    if (/^(test|beta)(\/|$)/.test(name))
      return "test / beta 禁止合入 feature 分支";
    if (!production) return "缺少 master / main，无法核验 feature 分支来源";
    if (!forbidden.size) return undefined;
    const commits = (
      await git(repo, ["rev-list", oid, "--not", production])
    ).stdout.split("\n");
    return commits.some((commit) => forbidden.has(commit))
      ? "包含 test / beta 独有提交，禁止合入 feature 分支"
      : undefined;
  };
}
