import type { WorkspaceLocation } from "../workspace-location.js";
import type {
  MergeBranchAncestor,
  MergeBranchBlockReason,
  MergeBranchCandidate,
  MergeBranchOptions,
  MergeBranchOptionsInput,
} from "./contracts.js";
import { GitMrError } from "./errors.js";
import { git, inspect } from "./repository.js";
import { loadSourcePolicy } from "./branch-policy.js";

/** Read-only eligibility; merge conflicts are resolvable, not grounds to disable a source. */
export async function inspectMergeBranches(
  location: WorkspaceLocation,
  input: MergeBranchOptionsInput,
): Promise<MergeBranchOptions> {
  const repo = await inspect(location);
  const refs = (
    await git(repo, [
      "for-each-ref",
      "--format=%(refname:strip=2)%00%(objectname)",
      "refs/heads/",
    ])
  ).stdout
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => {
      const [name, oid] = line.split("\0");
      return { name, oid };
    });
  const byName = new Map(refs.map((ref) => [ref.name, ref]));
  const target = byName.get(input.target);
  if (!target)
    throw new GitMrError("目标分支不存在，请刷新仓库。", "INVALID_BRANCH", 400);
  const production = byName.get("master") ?? byName.get("main");
  const policy = await loadSourcePolicy(repo, target.name);
  const bases = new Map<string, Promise<string[]>>();
  function mergeBases(left: string, right: string) {
    const key = [left, right].sort().join(":");
    if (!bases.has(key))
      bases.set(
        key,
        (async () => {
          const result = await git(repo, ["merge-base", "--all", left, right], {
            allowFailure: true,
          });
          if (result.status === 1) return [];
          if (result.status !== 0)
            throw new GitMrError(
              result.stderr || "无法读取分支祖先。",
              "GIT_COMMAND_FAILED",
              400,
            );
          return result.stdout.trim().split("\n").filter(Boolean);
        })(),
      );
    return bases.get(key)!;
  }
  async function ancestor(ref: {
    name: string;
    oid: string;
  }): Promise<MergeBranchAncestor> {
    const log = await git(
      repo,
      ["reflog", "show", "--format=%H%x00%gs", `refs/heads/${ref.name}`],
      { allowFailure: true },
    );
    if (log.status === 0) {
      const creation = log.stdout
        .split("\n")
        .reverse()
        .find((line) =>
          line.split("\0")[1]?.startsWith("branch: Created from "),
        );
      if (creation) {
        const [oid, subject] = creation.split("\0");
        const origin = subject
          .slice("branch: Created from ".length)
          .replace(/^refs\/heads\//, "");
        // HEAD/hash/revision expressions do not prove which branch was used. Never guess from today's HEAD.
        if (origin !== ref.name && byName.has(origin))
          return { branch: origin, oid, evidence: "creation_record" };
      }
    }
    if (production && production.name !== ref.name) {
      const common = await mergeBases(production.oid, ref.oid);
      if (common.length === 1)
        return {
          branch: production.name,
          oid: common[0],
          evidence: "merge_base",
        };
    }
    return { evidence: "unknown" };
  }
  const policyResults = new Map<string, Promise<string | undefined>>();
  function policyReason(ref: { name: string; oid: string }) {
    if (!policyResults.has(ref.name))
      policyResults.set(ref.name, policy(ref.name, ref.oid));
    return policyResults.get(ref.name)!;
  }
  async function eligibility(
    ref: { name: string; oid: string },
    against: { name: string; oid: string },
  ) {
    const blocked = (reason: MergeBranchBlockReason, detail: string) => ({
      reason,
      detail,
    });
    if (ref.name === target!.name)
      return blocked("same_branch", "当前目标分支");
    const prohibited = await policyReason(ref);
    if (prohibited) return blocked("branch_policy", prohibited);
    const common = await mergeBases(against.oid, ref.oid);
    if (!common.length)
      return blocked("unrelated_histories", "与目标没有共同历史");
    if (common.includes(ref.oid))
      return blocked("already_included", "提交已被目标包含，无需合并");
    if (input.strategy === "ff_only" && !common.includes(against.oid))
      return blocked(
        "not_fast_forward",
        `无法从 ${against.name} 快进，请调整顺序或策略`,
      );
    return undefined;
  }
  let comparison = target;
  const invalidSources: MergeBranchOptions["invalidSources"] = [];
  const selectedReasons = new Map<
    string,
    { reason: MergeBranchBlockReason; detail: string }
  >();
  for (const name of input.sources) {
    const ref = byName.get(name);
    const failure = !ref
      ? { reason: "invalid_queue" as const, detail: "分支已不存在" }
      : await eligibility(ref, comparison);
    if (failure) {
      invalidSources.push({ name, ...failure });
      selectedReasons.set(name, failure);
    } else if (input.strategy === "ff_only") comparison = ref!;
  }
  const branches: MergeBranchCandidate[] = [];
  // Bound subprocess concurrency; source ordering still defines fast-forward eligibility.
  for (let start = 0; start < refs.length; start += 4) {
    branches.push(
      ...(await Promise.all(
        refs.slice(start, start + 4).map(async (ref) => {
          const failure = input.sources.includes(ref.name)
            ? selectedReasons.get(ref.name)
            : await eligibility(ref, comparison);
          return {
            ...ref,
            ancestor: await ancestor(ref),
            mergeBaseOids: await mergeBases(target.oid, ref.oid),
            enabled: !failure,
            ...failure,
          };
        }),
      )),
    );
  }
  return {
    target: target.name,
    targetOid: target.oid,
    comparisonBranch: comparison.name,
    branches,
    invalidSources,
  };
}
