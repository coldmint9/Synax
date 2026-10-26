import { loadSourcePolicy } from "./branch-policy.js";
import { reconcile } from "./recovery.js";
import { assertMergeContentPolicy } from './content-policy.js';
import { conflictFilePacket, CONFLICT_PACKET_BYTES, type ConflictPacketInput } from './conflict-packet.js';
import { resolveHunks, type ConflictResolution } from './conflict-hunks.js';
import { applyRepairEdits, readRepairFile, replaceRepairFile, repairDiagnostics, MAX_REPAIR_ATTEMPTS, type CandidateRepair } from './candidate-repair.js';
import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import type { WorkspaceLocation } from "../workspace-location.js";
import { GitMrStore, gitMrStore } from "./store.js";
import { GitMrError } from "./errors.js";
import {
  inspect,
  branchOid,
  assertBranchPolicy,
  git,
  worktrees,
  ensureClean,
  repoPath,
  hostPath,
  command,
  MAX_FILE_BYTES,
} from "./repository.js";
import { listFiles, readFile, readFileSlice, writeFile, invalidateMergeFileIndex, releaseMergeFileCaches } from "./files.js";
import type {
  MergeRequest,
  MergeRequestInput,
  MergeFileSave,
  MergePreset,
  MergeProposal,
  MergeCheckConfig,
  MergeFileSliceInput,
} from "./contracts.js";

const terminal = new Set(["merged", "noop", "cancelled"]);
export type MergeMutationGuard = () => Promise<void>;
export class GitMrService {
  private controllers = new Map<string, AbortController>();
  constructor(
    readonly store: GitMrStore = gitMrStore,
    private readonly worktreeBusy: (
      directory: string,
    ) => Promise<boolean> = async () => false,
  ) {}
  async get(projectId: string, id: string) {
    const mr = await this.store.get(projectId, id);
    if (
      ["preparing", "checking", "applying"].includes(mr.status) &&
      !(await this.store.operationActive(mr.commonDir))
    )
      return {
        ...mr,
        status: "interrupted" as const,
        error:
          "The previous operation stopped. Reconcile the retained Git state to resume.",
      };
    return mr;
  }
  async list(projectId: string) {
    const records = await this.store.list<MergeRequest>("requests", projectId);
    return (
      await Promise.all(records.map((record) => this.get(projectId, record.id)))
    ).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }
  async create(
    projectId: string,
    location: WorkspaceLocation,
    input: MergeRequestInput,
  ) {
    if (!input.sources.length || input.sources.length > 30)
      throw new GitMrError(
        "Select between 1 and 30 source branches.",
        "INVALID_INPUT",
        400,
      );
    assertBranchPolicy(input.target, input.sources);
    const repo = await inspect(location);
    const targetOid = await branchOid(repo, input.target);
    const steps = await Promise.all(
      input.sources.map(async (branch) => ({
        branch,
        oid: await branchOid(repo, branch),
        status: "pending" as const,
      })),
    );
    for (const step of steps) {
      const base = await git(repo, ["merge-base", targetOid, step.oid], {
        allowFailure: true,
      });
      if (base.status !== 0)
        throw new GitMrError(
          "Branches must have a common ancestor.",
          "UNRELATED_HISTORIES",
          400,
        );
    }
    const mr: MergeRequest = {
      ...repo,
      id: randomUUID(),
      projectId,
      rootId: input.rootId,
      title: input.title,
      target: input.target,
      targetOid,
      strategy: input.strategy,
      steps,
      status: "draft",
      version: 1,
      currentStep: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      events: [],
      checks: input.checks ?? [],
      checkResults: [],
      autoFinalize: input.autoFinalize ?? false,
      allowCheckedOutTarget: input.allowCheckedOutTarget ?? false,
    };
    if (mr.autoFinalize && !mr.checks.length)
      throw new GitMrError(
        "Automatic merge requires at least one configured check.",
        "CHECKS_REQUIRED",
        400,
      );
    await this.checkBranchAncestry(mr);
    await this.store.write("requests", mr);
    return mr;
  }
  private async checkBranchAncestry(mr: MergeRequest) {
    assertBranchPolicy(
      mr.target,
      mr.steps.map((step) => step.branch),
    );
    const policy = await loadSourcePolicy(mr, mr.target);
    for (const step of mr.steps) {
      const reason = await policy(step.branch, step.oid);
      if (reason) throw new GitMrError(reason, "BRANCH_POLICY");
    }
  }

  private async current(mr: MergeRequest) {
    if ((await branchOid(mr, mr.target)) !== mr.targetOid)
      throw new GitMrError(
        "Target moved since this MR was created. Create a fresh MR.",
        "STALE_PLAN",
      );
    for (const step of mr.steps)
      if ((await branchOid(mr, step.branch)) !== step.oid)
        throw new GitMrError(
          `Source ${step.branch} moved. Create a fresh MR.`,
          "STALE_PLAN",
        );
    await this.checkBranchAncestry(mr);
  }
  private async mutate(
    projectId: string,
    id: string,
    expectedVersion: number,
    action: (mr: MergeRequest) => Promise<void>,
    guard?: MergeMutationGuard,
  ) {
    const original = await this.get(projectId, id);
    return this.store.exclusive(original.commonDir, async () => {
      const mr = await this.get(projectId, id);
      if (mr.version !== expectedVersion)
        throw new GitMrError("MR changed; refresh and retry.", "STALE_VERSION");
      await guard?.();
      try {
        await action(mr);
      } catch (error) {
        if (["preparing", "checking", "applying"].includes(mr.status))
          mr.status = mr.status === "applying" ? "interrupted" : "failed";
        mr.error = error instanceof Error ? error.message : String(error);
        await this.store.save(mr, mr.error);
        throw error;
      }
      mr.error = undefined;
      return this.store.save(mr);
    });
  }
  async prepare(projectId: string, id: string, version: number, guard?: MergeMutationGuard) {
    return this.mutate(projectId, id, version, async (mr) => {
      if (mr.status !== "draft")
        throw new GitMrError("Only a draft can be prepared.", "INVALID_STATE");
      await this.current(mr);
      mr.status = "preparing";
      await this.store.save(mr, "Preparing an isolated merge worktree.");
      const common = (
        await git(mr, [
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        ])
      ).stdout.trim();
      mr.worktree = repoPath(mr).join(common, "synax-mr-worktrees", mr.id);
      await fs.mkdir(path.dirname(hostPath(mr, mr.worktree)), {
        recursive: true,
      });
      await this.store.save(mr);
      await git(mr, ["worktree", "add", "--detach", mr.worktree, mr.targetOid]);
      await this.advance(mr);
      if ((mr.status as string) === "ready" && mr.autoFinalize) {
        await this.runChecks(mr);
        if ((mr.status as string) === "ready") await this.publish(mr);
      }
    }, guard);
  }
  private async noOsMetadata(mr: MergeRequest) {
    const tree = (
      await git(mr, ["ls-files", "-z"], { cwd: mr.worktree })
    ).stdout.split("\0");
    if (tree.some((file) => file.split("/").at(-1) === ".DS_Store"))
      throw new GitMrError(
        ".DS_Store must never be tracked. Remove it from the source branch first.",
        "BRANCH_POLICY",
      );
    await assertMergeContentPolicy(mr);
  }
  private async anchor(mr: MergeRequest) {
    const current = (
      await git(mr, ["rev-parse", "HEAD"], { cwd: mr.worktree })
    ).stdout.trim();
    await git(mr, ["update-ref", `refs/synax/mr/${mr.id}/candidate`, current]);
    mr.candidateOid = current;
  }
  private async commitStep(mr: MergeRequest) {
    const step = mr.steps[mr.currentStep];
    const conflicts = (
      await git(mr, ["ls-files", "-u", "-z"], { cwd: mr.worktree })
    ).stdout;
    if (conflicts)
      throw new GitMrError(
        "Resolve all conflicts before continuing.",
        "UNRESOLVED_CONFLICTS",
      );
    await this.noOsMetadata(mr);
    const staged = await git(mr, ["diff", "--cached", "--quiet"], {
      cwd: mr.worktree,
      allowFailure: true,
    });
    if (staged.status !== 0 && staged.status !== 1)
      throw new GitMrError("Unable to inspect staged changes.");
    // Empty squash changes produce no new commit; merge commits still preserve parent history.
    if (mr.strategy === "squash" && staged.status === 0) step.status = "noop";
    else {
      await git(
        mr,
        [
          "commit",
          "-m",
          `Merge ${step.branch} into ${mr.target} (Synax ${mr.id})`,
        ],
        { cwd: mr.worktree },
      );
      step.status = "completed";
    }
    await ensureClean(mr, mr.worktree!);
    await this.anchor(mr);
    step.outputOid = mr.candidateOid;
    mr.currentStep++;
    await this.store.save(mr, `${step.branch}: ${step.status}`);
  }
  private async advance(mr: MergeRequest) {
    const cwd = mr.worktree!;
    while (mr.currentStep < mr.steps.length) {
      const step = mr.steps[mr.currentStep];
      await this.current(mr);
      await ensureClean(mr, cwd);
      const head = (
        await git(mr, ["rev-parse", "HEAD"], { cwd })
      ).stdout.trim();
      step.inputOid = head;
      if (
        (
          await git(mr, ["merge-base", "--is-ancestor", step.oid, head], {
            allowFailure: true,
          })
        ).status === 0
      ) {
        step.status = "noop";
        step.outputOid = head;
        mr.currentStep++;
        continue;
      }
      step.status = "merging";
      mr.status = "preparing";
      await this.store.save(mr, `Merging ${step.branch}.`);
      const args =
        mr.strategy === "ff_only"
          ? ["merge", "--ff-only", step.oid]
          : mr.strategy === "squash"
            ? ["merge", "--squash", step.oid]
            : ["merge", "--no-ff", "--no-commit", step.oid];
      const result = await git(
        mr,
        ["-c", "merge.conflictStyle=diff3", ...args],
        { cwd, allowFailure: true },
      );
      invalidateMergeFileIndex(mr.id);
      const unresolved = (await git(mr, ["ls-files", "-u", "-z"], { cwd }))
        .stdout;
      if (unresolved) {
        step.status = "conflicted";
        mr.status = "conflicted";
        await this.store.save(mr, `Resolve conflicts in ${step.branch}.`);
        return;
      }
      if (result.status !== 0)
        throw new GitMrError(
          result.stderr || result.stdout,
          "MERGE_FAILED",
          400,
        );
      if (mr.strategy === "ff_only") {
        await this.noOsMetadata(mr);
        step.status = "completed";
        await this.anchor(mr);
        step.outputOid = mr.candidateOid;
        mr.currentStep++;
      } else await this.commitStep(mr);
    }
    await this.anchor(mr);
    await ensureClean(mr, cwd);
    await this.noOsMetadata(mr);
    mr.candidateTree = (
      await git(mr, ["rev-parse", "HEAD^{tree}"], { cwd })
    ).stdout.trim();
    mr.status = mr.candidateOid === mr.targetOid ? "noop" : "ready";
    await this.store.save(
      mr,
      "All source branches prepared; target has not been changed.",
    );
  }
  async continue(projectId: string, id: string, version: number, guard?: MergeMutationGuard) {
    return this.mutate(projectId, id, version, async (mr) => {
      if (mr.status !== "conflicted")
        throw new GitMrError(
          "MR is not waiting for conflict resolution.",
          "INVALID_STATE",
        );
      await this.current(mr);
      await this.commitStep(mr);
      await this.advance(mr);
      if ((mr.status as string) === "ready" && mr.autoFinalize) {
        await this.runChecks(mr);
        if ((mr.status as string) === "ready") await this.publish(mr);
      }
    }, guard);
  }
  async files(projectId: string, id: string) {
    return listFiles(await this.get(projectId, id));
  }
  async conflictPacket(projectId: string, id: string, input: ConflictPacketInput = {}, signal?: AbortSignal) {
    const mr = await this.get(projectId, id);
    const files = (await listFiles(mr, signal)).filter(file => file.conflicted);
    const selected = input.fileId ? files.filter(file => file.id === input.fileId) : files;
    if (input.fileId && !selected.length) throw new GitMrError('Conflict file not found.', 'NOT_FOUND', 404);
    const offset = input.offset ?? 0, limit = input.limit ?? 10, hunkOffset = input.hunkOffset ?? 0;
    if (![offset, hunkOffset].every(value => Number.isSafeInteger(value) && value >= 0) || !Number.isInteger(limit) || limit < 1 || limit > 20)
      throw new GitMrError('Invalid conflict packet page.', 'INVALID_INPUT', 400);
    const packets: ReturnType<typeof conflictFilePacket>[] = [];
    let bytes = 2048;
    for (const summary of selected.slice(offset, offset + limit)) {
      signal?.throwIfAborted();
      const packet = conflictFilePacket(await this.file(projectId, id, summary.id, signal), hunkOffset);
      // A single unusually large hunk is explicitly a preview; it never
      // silently displaces the pagination cursor or expands the model budget.
      while (Buffer.byteLength(JSON.stringify(packet)) > CONFLICT_PACKET_BYTES - 2048 && packet.hunks.length > 1) {
        packet.hunks.pop(); packet.nextHunkOffset = hunkOffset + packet.hunks.length;
      }
      const size = Buffer.byteLength(JSON.stringify(packet));
      if (bytes + size > CONFLICT_PACKET_BYTES && packets.length) break;
      packets.push(packet); bytes += size;
    }
    return { mrVersion: mr.version, target: mr.target, source: mr.steps[mr.currentStep]?.branch,
      totalFiles: files.length, files: packets,
      nextOffset: offset + packets.length < selected.length ? offset + packets.length : null };
  }

  async resolveBatch(projectId: string, id: string, version: number, files: ConflictResolution[], guard?: MergeMutationGuard) {
    if (!files.length || files.length > 20 || new Set(files.map(file => file.fileId)).size !== files.length)
      throw new GitMrError('Provide 1–20 distinct conflict files.', 'INVALID_INPUT', 400);
    return this.mutate(projectId, id, version, async mr => {
      if (mr.status !== 'conflicted') throw new GitMrError('No active conflicts to resolve.', 'INVALID_STATE');
      await this.current(mr);
      // Validate every revision and every hunk before the first write.
      const prepared = [];
      let bytes = 0;
      for (const decision of files) {
        const file = await this.file(projectId, id, decision.fileId);
        if (file.path.split('/').at(-1) === '.DS_Store') throw new GitMrError('.DS_Store must never be tracked.', 'BRANCH_POLICY');
        if (!file.conflicted || file.revision !== decision.expectedRevision)
          throw new GitMrError(`Conflict changed: ${file.path}. Reload the packet.`, 'STALE_DRAFT');
        if (decision.choice && (decision.hunks?.length || file.kind === 'text'))
          throw new GitMrError('Use hunk decisions for text; whole-file choices are only for structural/binary conflicts.', 'INVALID_INPUT', 400);
        if (file.reason?.startsWith('Submodule')) throw new GitMrError(file.reason, 'UNSUPPORTED_CONFLICT');
        const save: MergeFileSave = decision.choice
          ? { expectedRevision: file.revision, choice: decision.choice, resolve: true }
          : { expectedRevision: file.revision, ...resolveHunks(file, decision.hunks ?? []) };
        const size = Buffer.byteLength(save.content ?? ''); bytes += size;
        if (size > MAX_FILE_BYTES || bytes > 8 * MAX_FILE_BYTES)
          throw new GitMrError('Resolution batch exceeds the text editing budget.', 'FILE_TOO_LARGE');
        // Draft decisions use a visible revision; the file writer validates
        // the underlying content revision again at its mutation boundary.
        const raw = await readFile(mr, file.id);
        if ((await this.visibleFileRevision(id, file.id, raw.revision)).revision !== decision.expectedRevision)
          throw new GitMrError(`Conflict changed while preparing the batch: ${file.path}.`, 'STALE_DRAFT');
        prepared.push({ file, save: { ...save, expectedRevision: raw.revision } });
      }
      let applied = 0;
      try {
        for (const { file, save } of prepared) {
          await writeFile(mr, file.id, save, guard);
          applied++;
          mr.checkResults = []; mr.skippedChecks = undefined;
          await this.store.save(mr, `${save.resolve ? 'Resolved' : 'Updated conflict blocks'}: ${file.path}`);
        }
      } catch (error) {
        // A stop/I/O failure retains completed file decisions. Re-entry reads
        // those real staged results; it never replays the batch blindly.
        if (applied) await this.store.save(mr, `Batch interrupted after ${applied}/${prepared.length} files; completed decisions retained.`);
        throw error;
      }
    }, guard);
  }

  async repairContext(projectId: string, id: string) {
    const mr = await this.get(projectId, id);
    await this.verifyCandidate(mr);
    return repairDiagnostics(mr);
  }

  async repairRead(projectId: string, id: string, file: string, offset = 0, limit = 24_000) {
    if (!Number.isSafeInteger(offset) || offset < 0 || !Number.isInteger(limit) || limit < 1 || limit > 48_000)
      throw new GitMrError('Invalid repair read page.', 'INVALID_INPUT', 400);
    const mr = await this.get(projectId, id);
    await this.verifyCandidate(mr);
    const diagnostics = await repairDiagnostics(mr);
    const read = await readRepairFile(mr, file, diagnostics.files);
    return { path: read.path, revision: read.revision, candidateOid: mr.candidateOid, offset,
      content: read.content.slice(offset, offset + limit), totalCharacters: read.content.length,
      nextOffset: offset + limit < read.content.length ? offset + limit : null };
  }

  async repairCandidate(projectId: string, id: string, version: number, files: CandidateRepair[], guard?: MergeMutationGuard) {
    if (!files.length || files.length > 10 || new Set(files.map(file => file.path)).size !== files.length)
      throw new GitMrError('Provide 1–10 distinct diagnostic files.', 'INVALID_INPUT', 400);
    return this.mutate(projectId, id, version, async mr => {
      await this.current(mr);
      await this.verifyCandidate(mr);
      const diagnostics = await repairDiagnostics(mr);
      if ((mr.repairAttempts ?? 0) >= MAX_REPAIR_ATTEMPTS)
        throw new GitMrError('Verification still fails after three candidate repair rounds. Report the remaining diagnostics.', 'REPAIR_LIMIT');
      const prepared = [];
      for (const repair of files) {
        const original = await readRepairFile(mr, repair.path, diagnostics.files);
        if (original.revision !== repair.expectedRevision) throw new GitMrError(`Repair file changed: ${repair.path}.`, 'STALE_DRAFT');
        prepared.push({ ...original, replacement: applyRepairEdits(original.content, repair.edits) });
      }
      await guard?.();
      const parentOid = mr.candidateOid!;
      mr.repairAttempts = (mr.repairAttempts ?? 0) + 1;
      const message = `Repair merge verification (Synax ${mr.id} #${mr.repairAttempts})`;
      mr.repair = { parentOid, paths: files.map(file => file.path), message };
      mr.status = 'preparing';
      await this.store.save(mr, `Repairing ${files.length} diagnostic file(s) in the isolated candidate.`);
      const changed: typeof prepared = [];
      try {
        for (const item of prepared) {
          await guard?.();
          const current = await readRepairFile(mr, item.path, diagnostics.files);
          if (current.revision !== item.revision) throw new GitMrError('Candidate changed during repair.', 'STALE_DRAFT');
          changed.push(item);
          await replaceRepairFile(mr, item.path, item.content, item.replacement);
        }
        await guard?.();
        await git(mr, ['add', '--', ...files.map(file => file.path)], { cwd: mr.worktree });
        const staged = (await git(mr, ['diff', '--cached', '--name-only', '-z'], { cwd: mr.worktree })).stdout.split('\0').filter(Boolean);
        if (staged.some(file => !files.some(repair => repair.path === file)))
          throw new GitMrError('Unexpected staged files appeared during repair; candidate retained for inspection.', 'STALE_CANDIDATE');
        await this.noOsMetadata(mr);
        await guard?.();
        await git(mr, ['commit', '-m', message], { cwd: mr.worktree });
        await ensureClean(mr, mr.worktree!);
        await this.anchor(mr);
        mr.candidateTree = (await git(mr, ['rev-parse', 'HEAD^{tree}'], { cwd: mr.worktree })).stdout.trim();
        mr.checkResults = []; mr.skippedChecks = undefined; mr.status = 'ready'; mr.repair = undefined;
      } catch (error) {
        // Roll back only our own unchanged writes before a commit. If anything
        // else touched them, retain the journal and require reconciliation.
        const head = (await git(mr, ['rev-parse', 'HEAD'], { cwd: mr.worktree })).stdout.trim();
        if (head === parentOid) {
          const unchanged = await Promise.all(changed.map(async item => {
            const stat = await fs.lstat(item.destination);
            if (!stat.isFile() || stat.isSymbolicLink()) return false;
            const content = await fs.readFile(item.destination, 'utf8');
            return content === item.replacement || content === item.content;
          }));
          if (unchanged.every(Boolean)) {
            for (const item of changed) {
              const content = await fs.readFile(item.destination, 'utf8');
              if (content !== item.content) await replaceRepairFile(mr, item.path, item.replacement, item.content);
            }
            if (changed.length) await git(mr, ['add', '--', ...changed.map(item => item.path)], { cwd: mr.worktree });
            mr.repair = undefined;
          }
        }
        mr.status = mr.repair ? 'interrupted' : 'check_failed';
        throw error;
      }
    }, guard);
  }
  private async visibleFileRevision(id: string, fileId: string, revision: string) {
    const draft = await this.store.read<{ contentRevision: string; revision: string; state: unknown }>('drafts', `${id}-${fileId}`).catch(() => null);
    const matching = draft?.contentRevision === revision;
    return { revision: matching ? createHash('sha256').update(revision + draft!.revision).digest('hex') : revision,
      resolutionState: matching ? draft!.state : undefined };
  }
  async file(projectId: string, id: string, fileId: string, signal?: AbortSignal) {
    const mr = await this.get(projectId, id);
    const file = await readFile(mr, fileId, false, signal);
    const draft = await this.visibleFileRevision(id, fileId, file.revision);
    return {
      ...file,
      revision: draft.revision,
      targetLabel: `${mr.target} · ${mr.steps[mr.currentStep]?.inputOid?.slice(0, 8) ?? mr.targetOid.slice(0, 8)}`,
      sourceLabel: `${mr.steps[mr.currentStep]?.branch ?? "累计结果"} · ${mr.steps[mr.currentStep]?.oid.slice(0, 8) ?? mr.candidateOid?.slice(0, 8) ?? ""}`,
      resolutionState: draft.resolutionState,
    };
  }
  async fileSlice(projectId: string, id: string, fileId: string, input: MergeFileSliceInput, signal?: AbortSignal) {
    const slice = await readFileSlice(await this.get(projectId, id), fileId, input, signal);
    const visible = await this.visibleFileRevision(id, fileId, slice.revision);
    if (visible.revision !== input.expectedRevision) throw new GitMrError('The file changed. Reload before reading another page.', 'STALE_DRAFT');
    return { ...slice, revision: visible.revision };
  }
  async saveFile(
    projectId: string,
    id: string,
    fileId: string,
    input: MergeFileSave,
    expectedVersion?: number,
    guard?: MergeMutationGuard,
  ) {
    const original = await this.get(projectId, id);
    if (
      input.resolutionState !== undefined &&
      Buffer.byteLength(JSON.stringify(input.resolutionState)) > 100 * 1024
    )
      throw new GitMrError(
        "Resolution state exceeds 100 KB.",
        "INVALID_INPUT",
        400,
      );
    return this.store.exclusive(original.commonDir, async () => {
      const mr = await this.get(projectId, id);
      await guard?.();
      if (expectedVersion !== undefined && mr.version !== expectedVersion)
        throw new GitMrError("MR changed; refresh before saving.", "STALE_VERSION");
      const visible = await this.file(projectId, id, fileId);
      if (visible.revision !== input.expectedRevision)
        throw new GitMrError(
          "The conflict draft or its decisions changed. Reload first.",
          "STALE_DRAFT",
        );
      const raw = await readFile(mr, fileId);
      const before = await writeFile(mr, fileId, {
        ...input,
        expectedRevision: raw.revision,
      }, guard);
      mr.checkResults = [];
      await this.store.save(
        mr,
        `${input.resolve ? "Resolved" : "Saved draft"}: ${before.path}`,
      );
      const next = await readFile(mr, fileId).catch(() => null);
      if (next)
        await this.store.write("drafts", {
          id: `${mr.id}-${fileId}`,
          contentRevision: next.revision,
          revision: randomUUID(),
          state: input.resolutionState,
        });
      try {
        return await this.file(projectId, id, fileId);
      } catch (error) {
        if (
          input.resolve &&
          error instanceof GitMrError &&
          error.code === "NOT_FOUND"
        )
          return {
            ...before,
            conflicted: false,
            result:
              input.content ??
              (input.choice === "target"
                ? before.target
                : input.choice === "source"
                  ? before.source
                  : ""),
            revision: randomUUID(),
          };
        throw error;
      }
    });
  }
  private async verifyCandidate(mr: MergeRequest) {
    if (!mr.worktree || !mr.candidateOid || !mr.candidateTree)
      throw new GitMrError(
        "No completed candidate is available.",
        "INVALID_STATE",
      );
    await ensureClean(mr, mr.worktree);
    const head = (
      await git(mr, ["rev-parse", "HEAD"], { cwd: mr.worktree })
    ).stdout.trim();
    if (head !== mr.candidateOid)
      throw new GitMrError(
        "Candidate changed outside this merge request.",
        "STALE_CANDIDATE",
      );
  }
  private async runChecks(mr: MergeRequest) {
    mr.skippedChecks = undefined;
    await this.current(mr);
    await this.verifyCandidate(mr);
    if (!mr.checks.length)
      throw new GitMrError(
        "No verification commands configured. Manual finalize remains available.",
        "NO_CHECKS",
        400,
      );
    mr.status = "checking";
    mr.checkResults = [];
    await this.store.save(mr, "Running configured verification commands.");
    const controller = new AbortController();
    this.controllers.set(mr.id, controller);
    try {
      for (const check of mr.checks) {
        const result = await command(
          mr,
          mr.worktree!,
          check.executable,
          check.args,
          { timeoutMs: check.timeoutMs, signal: controller.signal },
        );
        mr.checkResults.push({
          id: check.id,
          status: result.status === 0 ? "passed" : "failed",
          output: (result.stdout + "\n" + result.stderr).slice(-50_000),
          tree: mr.candidateTree!,
          finishedAt: new Date().toISOString(),
        });
        await this.verifyCandidate(mr);
        await this.store.save(
          mr,
          `${check.id}: ${result.status === 0 ? "passed" : "failed"}`,
        );
        if (result.status !== 0) {
          mr.status = "check_failed";
          return;
        }
      }
      mr.status = "ready";
    } finally {
      this.controllers.delete(mr.id);
    }
  }
  async checks(projectId: string, id: string, version: number, guard?: MergeMutationGuard) {
    return this.mutate(projectId, id, version, async (mr) => {
      if (!["ready", "check_failed", "failed"].includes(mr.status))
        throw new GitMrError(
          "Prepare all branches before checking.",
          "INVALID_STATE",
        );
      await this.runChecks(mr);
    }, guard);
  }
  async configureChecks(projectId: string, id: string, version: number, checks: MergeCheckConfig[]) {
    return this.mutate(projectId, id, version, async mr => {
      if (terminal.has(mr.status) || ['preparing', 'checking', 'applying'].includes(mr.status))
        throw new GitMrError('Stop the current merge operation before changing verification.', 'INVALID_STATE');
      if (!checks.length) throw new GitMrError('At least one grounded verification command is required.', 'CHECKS_REQUIRED');
      mr.checks = checks; mr.checkResults = []; mr.skippedChecks = undefined;
    });
  }
  private async publish(mr: MergeRequest, skipChecks = false, guard?: MergeMutationGuard) {
    await this.current(mr);
    await this.verifyCandidate(mr);
    await this.noOsMetadata(mr);
    if (
      !skipChecks && mr.checks.some(
        (check) =>
          !mr.checkResults.some(
            (result) =>
              result.id === check.id &&
              result.status === "passed" &&
              result.tree === mr.candidateTree,
          ),
      )
    )
      throw new GitMrError(
        "Every configured check must pass for this candidate.",
        "CHECKS_REQUIRED",
      );
    if (
      (
        await git(
          mr,
          ["merge-base", "--is-ancestor", mr.targetOid, mr.candidateOid!],
          { allowFailure: true },
        )
      ).status !== 0
    )
      throw new GitMrError(
        "Candidate is not a descendant of the target.",
        "INVALID_CANDIDATE",
      );
    const checkedOut = (await worktrees(mr)).filter(
      (item) => item.branch === `refs/heads/${mr.target}`,
    );
    if (checkedOut.length > 1)
      throw new GitMrError(
        "Target is checked out in multiple worktrees.",
        "TARGET_BUSY",
      );
    if (checkedOut.length) {
      if (!mr.allowCheckedOutTarget)
        throw new GitMrError(
          "Target is checked out. Explicitly allow application in its clean worktree when creating the MR.",
          "TARGET_BUSY",
        );
      const directory = checkedOut[0].path;
      if (await this.worktreeBusy(hostPath(mr, directory)))
        throw new GitMrError(
          "An agent is using the target worktree.",
          "TARGET_BUSY",
        );
      await ensureClean(mr, directory);
      const symbolic = (
        await git(mr, ["symbolic-ref", "-q", "HEAD"], {
          cwd: directory,
          allowFailure: true,
        })
      ).stdout.trim();
      if (symbolic !== `refs/heads/${mr.target}`)
        throw new GitMrError(
          "Target worktree switched branches. Refresh before applying.",
          "TARGET_BUSY",
        );
      const head = (
        await git(mr, ["rev-parse", "HEAD"], { cwd: directory })
      ).stdout.trim();
      if (head !== mr.targetOid)
        throw new GitMrError("Target worktree changed.", "STALE_PLAN");
      await git(mr, [
        "update-ref",
        `refs/synax/mr/${mr.id}/before`,
        mr.targetOid,
      ]);
      mr.application = {
        candidateOid: mr.candidateOid!,
        targetOid: mr.targetOid,
        startedAt: new Date().toISOString(),
      };
      mr.status = "applying";
      await this.store.save(
        mr,
        "Applying verified candidate in target worktree.",
      );
      await guard?.();
      await git(mr, ["merge", "--ff-only", mr.candidateOid!], {
        cwd: directory,
      });
      if ((await branchOid(mr, mr.target)) !== mr.candidateOid)
        throw new GitMrError(
          "Target changed during application. Inspect the worktree before recovery.",
          "APPLICATION_RACE",
        );
      await ensureClean(mr, directory);
    } else {
      mr.application = {
        candidateOid: mr.candidateOid!,
        targetOid: mr.targetOid,
        startedAt: new Date().toISOString(),
      };
      mr.status = "applying";
      await this.store.save(mr, "Updating target ref with expected old OID.");
      const commands = [
        `start`,
        ...mr.steps.map(
          (step) => `verify refs/heads/${step.branch} ${step.oid}`,
        ),
        `create refs/synax/mr/${mr.id}/before ${mr.targetOid}`,
        `update refs/heads/${mr.target} ${mr.candidateOid} ${mr.targetOid}`,
        "prepare",
        "commit",
        "",
      ];
      await guard?.();
      await git(mr, ["update-ref", "--stdin"], { stdin: commands.join("\n") });
    }
    mr.status = "merged";
    await this.store.save(mr, `Merged into ${mr.target}: ${mr.candidateOid}`);
    await releaseMergeFileCaches(mr.id).catch(() => undefined);
  }
  async finalize(projectId: string, id: string, version: number, options: { skipChecks?: boolean; guard?: MergeMutationGuard } = {}) {
    return this.mutate(projectId, id, version, async (mr) => {
      if (mr.status !== "ready" && !(options.skipChecks && mr.status === "check_failed"))
        throw new GitMrError("MR is not ready to merge.", "INVALID_STATE");
      if (options.skipChecks) {
        await this.current(mr);
        await this.verifyCandidate(mr);
        mr.skippedChecks = { tree: mr.candidateTree!, at: new Date().toISOString() };
        await this.store.save(mr, "User explicitly skipped verification for this candidate; checks are not marked passed.");
      }
      await this.publish(mr, options.skipChecks === true, options.guard);
    }, options.guard);
  }
  async cancel(projectId: string, id: string, version: number) {
    const mr = await this.get(projectId, id);
    const controller = this.controllers.get(id);
    if (controller) {
      controller.abort();
      throw new GitMrError(
        "Stopping checks. Refresh after the command exits, then cancel to retain the candidate.",
        "STOPPING",
      );
    }
    return this.mutate(projectId, id, version, async (record) => {
      if (terminal.has(record.status))
        throw new GitMrError(
          "This merge request is already finished.",
          "INVALID_STATE",
        );
      // Candidate worktree is intentionally retained: cancelling never destroys draft resolutions.
      if (
        record.application &&
        record.currentStep === record.steps.length &&
        record.application.candidateOid !== record.application.targetOid &&
        (await branchOid(record, record.target)) ===
          record.application.candidateOid
      ) {
        record.status = "merged";
        await this.store.save(
          record,
          "Target already contains the candidate; recorded actual completion.",
        );
        return;
      }
      record.status = "cancelled";
      await this.store.save(
        record,
        "Cancelled; isolated worktree retained for inspection.",
      );
    });
  }
  async resume(projectId: string, id: string, version: number, guard?: MergeMutationGuard) {
    return this.mutate(projectId, id, version, async (mr) => {
      if (
        ![
          "failed",
          "interrupted",
          "preparing",
          "checking",
          "applying",
        ].includes(mr.status)
      )
        throw new GitMrError(
          "This MR does not need recovery.",
          "INVALID_STATE",
        );
      await reconcile(mr);
      invalidateMergeFileIndex(mr.id);
      await releaseMergeFileCaches(mr.id).catch(() => undefined);
      if (mr.status === "interrupted") await this.advance(mr);
      // Recovered checks must be rerun; completion is inferred only from the actual target ref.
      if (mr.status !== "merged") mr.checkResults = [];
      await this.store.save(
        mr,
        "Reconciled the saved operation with actual Git state.",
      );
    }, guard);
  }
  /** Delete only the isolated worktree owned by this cancelled MR. Never reset a user's checkout. */
  async discard(projectId: string, id: string) {
    const original = await this.get(projectId, id);
    return this.store.exclusive(original.commonDir, async () => {
      const mr = await this.get(projectId, id);
      if (mr.status !== 'cancelled') throw new GitMrError('Only a cancelled merge can be discarded.', 'INVALID_STATE');
      if (mr.worktree) {
        const common = (await git(mr, ['rev-parse', '--path-format=absolute', '--git-common-dir'])).stdout.trim();
        const expected = repoPath(mr).join(common, 'synax-mr-worktrees', mr.id);
        if (repoPath(mr).normalize(mr.worktree) !== repoPath(mr).normalize(expected))
          throw new GitMrError('The candidate path is not owned by this merge.', 'UNSAFE_PATH');
        if (await this.worktreeBusy(hostPath(mr, mr.worktree))) throw new GitMrError('The candidate still has an active owner.', 'TARGET_BUSY');
        const present = (await worktrees(mr)).some(item => repoPath(mr).normalize(item.path) === repoPath(mr).normalize(mr.worktree!));
        if (present) await git(mr, ['worktree', 'remove', '--force', mr.worktree]);
        else if (await fs.stat(hostPath(mr, mr.worktree)).then(() => true, () => false))
          throw new GitMrError('Unregistered candidate path requires inspection before deletion.', 'RECOVERY_REQUIRED');
        mr.worktree = undefined;
      }
      await git(mr, ['update-ref', '-d', `refs/synax/mr/${mr.id}/candidate`]);
      mr.candidateOid = undefined; mr.candidateTree = undefined;
      invalidateMergeFileIndex(mr.id);
      await releaseMergeFileCaches(mr.id).catch(() => undefined);
      return this.store.save(mr, 'Cancelled merge candidate worktree removed.');
    });
  }
  async presets(projectId: string) {
    return this.store.list<MergePreset>("presets", projectId);
  }
  async preset(projectId: string, id: string) {
    const preset = await this.store.read<MergePreset>("presets", id);
    if (preset.projectId !== projectId)
      throw new GitMrError("Preset not found.", "NOT_FOUND", 404);
    return preset;
  }
  async savePreset(projectId: string, name: string, input: MergeRequestInput) {
    assertBranchPolicy(input.target, input.sources);
    const preset: MergePreset = {
      id: randomUUID(),
      projectId,
      name,
      input,
      version: 1,
      createdAt: new Date().toISOString(),
    };
    await this.store.write("presets", preset);
    return preset;
  }
  async deletePreset(projectId: string, id: string) {
    return this.store.deletePreset(projectId, id);
  }
  async runPreset(projectId: string, id: string, location: WorkspaceLocation) {
    return this.store.exclusive(`preset:${projectId}:${id}`, async () => {
      const preset = await this.preset(projectId, id);
      const existing = (await this.list(projectId)).find(
        (mr) =>
          (mr as MergeRequest & { presetId?: string }).presetId === id &&
          !terminal.has(mr.status),
      );
      if (existing) return existing;
      const mr = await this.create(projectId, location, preset.input);
      await this.store.write("requests", { ...mr, presetId: id });
      return this.prepare(projectId, mr.id, mr.version);
    });
  }
  async propose(
    projectId: string,
    id: string,
    input: {
      fileId: string;
      revision: string;
      content: string;
      rationale: string;
    },
  ) {
    const mr = await this.get(projectId, id);
    if (mr.status !== "conflicted")
      throw new GitMrError(
        "Proposals require an active conflict.",
        "INVALID_STATE",
      );
    const file = await this.file(projectId, id, input.fileId);
    if (file.revision !== input.revision)
      throw new GitMrError("File changed since it was read.", "STALE_DRAFT");
    if (file.kind !== "text")
      throw new GitMrError(
        "Only text conflict proposals are supported.",
        "UNSUPPORTED_CONFLICT",
      );
    if (input.content.length > 2 * 1024 * 1024)
      throw new GitMrError("Proposal too large.", "INVALID_INPUT", 400);
    const proposal: MergeProposal = {
      ...input,
      id: randomUUID(),
      mrId: id,
      createdAt: new Date().toISOString(),
    };
    await this.store.write("proposals", { ...proposal, projectId });
    return proposal;
  }
  async proposals(projectId: string, id: string) {
    await this.get(projectId, id);
    return this.store.proposals(projectId, id);
  }
  async applyProposal(
    projectId: string,
    id: string,
    proposalId: string,
    version: number,
  ) {
    const proposal = (await this.proposals(projectId, id)).find(
      (item) => item.id === proposalId,
    );
    if (!proposal)
      throw new GitMrError("Proposal not found.", "NOT_FOUND", 404);
    const mr = await this.get(projectId, id);
    if (mr.version !== version)
      throw new GitMrError("MR changed; refresh first.", "STALE_VERSION");
    return this.saveFile(projectId, id, proposal.fileId, {
      expectedRevision: proposal.revision,
      content: proposal.content,
      resolve: false,
    }, version);
  }
}
export const gitMrService = new GitMrService(gitMrStore, async (directory) => {
  const { agentRuntimeStore } =
    await import("../agent-runtime/session-store.js");
  const sessions = agentRuntimeStore.listSessions({
    limit: Number.MAX_SAFE_INTEGER,
  });
  return sessions.some((session) => {
    if (!session.activeRunId) return false;
    const backend = session.sessionMetadata?.backend as
      | { workDir?: string; workspaceRoots?: { path: string }[] }
      | undefined;
    return [
      backend?.workDir,
      ...(backend?.workspaceRoots ?? []).map((root) => root.path),
    ].some(
      (candidate) =>
        candidate && path.resolve(candidate) === path.resolve(directory),
    );
  });
});
