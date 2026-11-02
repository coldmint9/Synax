import { git, inspect } from "../git-mr/repository.js";
import { GitMrError } from "../git-mr/errors.js";
import { parseRemote, remoteChoice } from "./remote.js";
import type {
  RemoteChoice,
  RemotePrScope,
  RemoteRepository,
} from "./contracts.js";

/** A checkout inspected by the Git merge engine. */
export type PrRepository = Awaited<ReturnType<typeof inspect>>;
export type GitRunner = typeof git;

/** Resolve one configured remote into its platform identity. The push URL must
 * travel with the same validation, so both the session and project surfaces
 * share this single implementation. */
export async function resolvePrRemote(
  repo: PrRepository,
  input: RemotePrScope,
  runGit: GitRunner = git,
): Promise<RemoteRepository> {
  const names = (await runGit(repo, ["remote"])).stdout.trim().split("\n");
  if (!names.includes(input.remote))
    throw new GitMrError(
      "请选择已配置的 Git remote。",
      "PR_REMOTE_MISSING",
      400,
    );
  const urls = (
    await runGit(repo, ["remote", "get-url", "--all", input.remote])
  ).stdout
    .trim()
    .split("\n");
  if (urls.length !== 1)
    throw new GitMrError(
      "该 remote 有多个地址，请为合并请求使用单一仓库 remote。",
      "PR_REMOTE_AMBIGUOUS",
      409,
    );
  return parseRemote(input.remote, urls[0], input.provider);
}

/** Read the checkout state the merge preconditions depend on. */
export async function readPrLocalState(
  repo: PrRepository,
  runGit: GitRunner = git,
) {
  return {
    branch: (
      await runGit(repo, ["branch", "--show-current"])
    ).stdout.trim(),
    headSha: (await runGit(repo, ["rev-parse", "HEAD"])).stdout.trim(),
    dirty: Boolean(
      (await runGit(repo, ["status", "--porcelain=v1", "-z"])).stdout,
    ),
  };
}

export async function listPrRemotes(
  repo: PrRepository,
  runGit: GitRunner = git,
): Promise<RemoteChoice[]> {
  const names = (await runGit(repo, ["remote"])).stdout
    .trim()
    .split("\n")
    .filter(Boolean);
  return Promise.all(
    names.map(async (name) =>
      remoteChoice(
        name,
        (await runGit(repo, ["remote", "get-url", name])).stdout.trim(),
      ),
    ),
  );
}

export async function listPrBranches(
  repo: PrRepository,
  runGit: GitRunner = git,
): Promise<string[]> {
  return (
    await runGit(repo, [
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads",
    ])
  ).stdout
    .trim()
    .split("\n")
    .filter(Boolean);
}
