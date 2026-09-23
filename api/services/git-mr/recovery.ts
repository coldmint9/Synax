import { git, branchOid, ensureClean } from "./repository.js";
import { GitMrError } from "./errors.js";
import type { MergeRequest } from "./contracts.js";
/** Reconcile persisted intent against actual Git state, never reset user files or invent commits. */
export async function reconcile(mr: MergeRequest) {
  const target = await branchOid(mr, mr.target);
  if (
    mr.application &&
    mr.currentStep === mr.steps.length &&
    mr.application.candidateOid !== mr.application.targetOid &&
    target === mr.application.candidateOid
  ) {
    mr.status = "merged";
    return;
  }
  if (target !== mr.targetOid)
    throw new GitMrError(
      "Target moved; preserve the candidate and create a new MR.",
      "STALE_PLAN",
    );
  if (!mr.worktree) {
    mr.status = "draft";
    return;
  }
  const head = (
    await git(mr, ["rev-parse", "HEAD"], { cwd: mr.worktree })
  ).stdout.trim();
  const unresolved = (
    await git(mr, ["ls-files", "-u", "-z"], { cwd: mr.worktree })
  ).stdout;
  const step = mr.steps[mr.currentStep];
  const mergeHead = await git(mr, ["rev-parse", "--verify", "MERGE_HEAD"], {
    cwd: mr.worktree,
    allowFailure: true,
  });
  if (unresolved || mergeHead.status === 0) {
    if (!step || !step.inputOid || head !== step.inputOid)
      throw new GitMrError(
        "Merge state does not match the recorded step. Inspect retained worktree.",
        "RECOVERY_REQUIRED",
      );
    mr.status = "conflicted";
    step.status = "conflicted";
    return;
  }
  if (step?.status === "merging" || step?.status === "conflicted") {
    if (head === step.inputOid) {
      if (mr.strategy === "squash") {
        mr.status = "conflicted";
        step.status = "conflicted";
        return;
      }
      await ensureClean(mr, mr.worktree);
      step.status = "pending";
      mr.status = "interrupted";
      return;
    }
    const parents = (await git(mr, ["show", "-s", "--format=%P", head])).stdout
      .trim()
      .split(" ");
    const known =
      mr.strategy === "merge_commit"
        ? parents.length === 2 &&
          parents[0] === step.inputOid &&
          parents[1] === step.oid
        : mr.strategy === "ff_only"
          ? head === step.oid
          : parents.length === 1 && parents[0] === step.inputOid;
    if (!known)
      throw new GitMrError(
        "Unrecognized candidate commit; manual inspection is required.",
        "RECOVERY_REQUIRED",
      );
    await ensureClean(mr, mr.worktree);
    step.status = "completed";
    step.outputOid = head;
    mr.currentStep++;
    mr.candidateOid = head;
  }
  await ensureClean(mr, mr.worktree);
  if (mr.currentStep === mr.steps.length) {
    if (mr.candidateOid && head !== mr.candidateOid)
      throw new GitMrError(
        "Candidate changed outside Synax.",
        "STALE_CANDIDATE",
      );
    mr.candidateOid = head;
    mr.candidateTree = (
      await git(mr, ["rev-parse", "HEAD^{tree}"], { cwd: mr.worktree })
    ).stdout.trim();
    mr.status = head === mr.targetOid ? "noop" : "ready";
  } else mr.status = "interrupted";
}
