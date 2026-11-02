import { randomUUID } from "node:crypto";
import type { WorkspaceLocation } from "../workspace-location.js";
import { GitMrError } from "../git-mr/errors.js";
import { assertBranchPolicy, inspect } from "../git-mr/repository.js";
import { GitMrService, gitMrService } from "../git-mr/service.js";
import { GitMrStore, gitMrStore } from "../git-mr/store.js";
import {
  QUICK_MERGE_KINDS,
  type QuickMergeBoard,
  type QuickMergeGroup,
  type QuickMergeRule,
  type QuickMergeRuleInput,
  type QuickMergeRuleView,
  type QuickMergeStep,
  type QuickMergeStatus,
} from "./contracts.js";
import {
  aheadOfRemote,
  assertBranch,
  fetchRemote,
  pushBranch,
  syncBranch,
  syncStep,
} from "./git-ops.js";

const MAX_GROUPS = 40;
const MAX_RULES = 200;
const FEATURE = /^(?:feature(?:\/|$)|codex\/)/;
const RELEASE = /^(?:test|beta)(?:\/|$)/;

/** One direction check shared by creation and swap; wording stays actionable. */
function assertDirection(source: string, target: string) {
  if (source === target)
    throw new GitMrError("源分支与目标分支不能相同。", "INVALID_INPUT", 400);
  if (FEATURE.test(target) && RELEASE.test(source))
    throw new GitMrError("不能将 test 或 beta 合入功能分支。", "BRANCH_POLICY", 400);
  assertBranchPolicy(target, [source]);
}

/** Target checkout failures the board explains itself; everything else keeps the Git wording. */
const EXPLAINED = new Set([
  "TARGET_BUSY",
  "DIRTY_WORKTREE",
  "GIT_OPERATION_BUSY",
]);

/** Repository policy speaks English; the board shows one actionable sentence. */
function mergeFailure(error: unknown, target: string): string {
  if (!(error instanceof GitMrError))
    return error instanceof Error ? error.message : String(error);
  switch (error.code) {
    case "BRANCH_POLICY":
      return "不能将 test 或 beta 合入功能分支。";
    case "TARGET_BUSY":
      return `${target} 被多个工作树检出或正被占用，本次未自动合并。`;
    case "DIRTY_WORKTREE":
      return `${target} 所在工作树有未提交改动，先提交或暂存后再合并。`;
    case "GIT_OPERATION_BUSY":
      return `${target} 所在工作树还有未完成的 Git 操作，完成后再合并。`;
    default:
      return error.message;
  }
}

function ordered<T extends { order: number; createdAt: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => a.order - b.order || a.createdAt.localeCompare(b.createdAt));
}

export class QuickMergeService {
  constructor(
    private readonly store: GitMrStore = gitMrStore,
    private readonly mr: GitMrService = gitMrService,
  ) {}

  async groups(projectId: string): Promise<QuickMergeGroup[]> {
    return ordered(await this.store.list<QuickMergeGroup>(QUICK_MERGE_KINDS.groups, projectId));
  }

  async rules(projectId: string): Promise<QuickMergeRule[]> {
    return ordered(await this.store.list<QuickMergeRule>(QUICK_MERGE_KINDS.rules, projectId));
  }

  /** Rules carry the live status of the merge request they produced, so a
   * conflict resolved elsewhere is reflected here without a second run. */
  async board(projectId: string): Promise<QuickMergeBoard> {
    const [groups, rules] = await Promise.all([this.groups(projectId), this.rules(projectId)]);
    const views = await Promise.all(
      rules.map(async (rule) => {
        if (!rule.mrId) return rule;
        const mr = await this.mr.get(projectId, rule.mrId).catch(() => null);
        if (!mr) return rule;
        if (mr.status === "conflicted")
          return { ...rule, status: "conflicted" as QuickMergeStatus, message: "合并冲突，需要解决" };
        if ((mr.status === "merged" || mr.status === "noop") && rule.status !== "failed" && rule.status !== "pushed")
          return {
            ...rule,
            status: "merged" as QuickMergeStatus,
            message: mr.status === "noop" ? "无需合并" : rule.message,
          };
        return rule;
      }),
    );
    return { groups, rules: views };
  }

  private async writeGroup(projectId: string, group: QuickMergeGroup) {
    await this.store.write(QUICK_MERGE_KINDS.groups, group);
    return group;
  }

  async createGroup(projectId: string, input: { rootId?: string; name: string }) {
    const name = input.name.trim();
    if (!name) throw new GitMrError("分组名称不能为空。", "INVALID_INPUT", 400);
    const groups = await this.groups(projectId);
    if (groups.length >= MAX_GROUPS)
      throw new GitMrError(`最多 ${MAX_GROUPS} 个分组。`, "TOO_MANY_GROUPS", 400);
    if (groups.some((group) => group.name === name))
      throw new GitMrError("已有同名分组。", "DUPLICATE_GROUP", 409);
    return this.writeGroup(projectId, {
      id: randomUUID(),
      projectId,
      rootId: input.rootId,
      name,
      order: groups.length,
      createdAt: new Date().toISOString(),
    });
  }

  private async requireGroup(projectId: string, groupId: string) {
    const group = await this.store.read<QuickMergeGroup>(QUICK_MERGE_KINDS.groups, groupId);
    if (group.projectId !== projectId)
      throw new GitMrError("分组不存在。", "NOT_FOUND", 404);
    return group;
  }

  async renameGroup(projectId: string, groupId: string, name: string) {
    const group = await this.requireGroup(projectId, groupId);
    const next = name.trim();
    if (!next) throw new GitMrError("分组名称不能为空。", "INVALID_INPUT", 400);
    const groups = await this.groups(projectId);
    if (groups.some((item) => item.name === next && item.id !== groupId))
      throw new GitMrError("已有同名分组。", "DUPLICATE_GROUP", 409);
    return this.writeGroup(projectId, { ...group, name: next });
  }

  async deleteGroup(projectId: string, groupId: string) {
    await this.requireGroup(projectId, groupId);
    const rules = await this.rules(projectId);
    await Promise.all(
      rules
        .filter((rule) => rule.groupId === groupId)
        .map((rule) => this.store.remove(QUICK_MERGE_KINDS.rules, projectId, rule.id)),
    );
    await this.store.remove(QUICK_MERGE_KINDS.groups, projectId, groupId);
  }

  async createRule(projectId: string, input: QuickMergeRuleInput) {
    const group = await this.requireGroup(projectId, input.groupId);
    const source = assertBranch(input.source, "源分支");
    const target = assertBranch(input.target, "目标分支");
    assertDirection(source, target);
    const rules = await this.rules(projectId);
    if (rules.length >= MAX_RULES)
      throw new GitMrError(`最多 ${MAX_RULES} 条指令。`, "TOO_MANY_RULES", 400);
    if (rules.some((rule) => rule.groupId === group.id && rule.source === source && rule.target === target))
      throw new GitMrError("该分组已有相同指令。", "DUPLICATE_RULE", 409);
    const rule: QuickMergeRule = {
      id: randomUUID(),
      projectId,
      rootId: input.rootId ?? group.rootId,
      groupId: group.id,
      source,
      target,
      order: rules.filter((item) => item.groupId === group.id).length,
      createdAt: new Date().toISOString(),
      status: "idle",
    };
    await this.store.write(QUICK_MERGE_KINDS.rules, rule);
    return rule;
  }

  private async requireRule(projectId: string, ruleId: string) {
    const rule = await this.store.read<QuickMergeRule>(QUICK_MERGE_KINDS.rules, ruleId);
    if (rule.projectId !== projectId)
      throw new GitMrError("指令不存在。", "NOT_FOUND", 404);
    return rule;
  }

  /** Swap rewrites the stored direction; the previous run no longer describes it. */
  async updateRule(projectId: string, ruleId: string, input: { source: string; target: string }) {
    const rule = await this.requireRule(projectId, ruleId);
    const source = assertBranch(input.source, "源分支");
    const target = assertBranch(input.target, "目标分支");
    // Reversing is a planning action, not a merge. A direction the repository
    // policy rejects is reported when the rule runs.
    if (source === target)
      throw new GitMrError("源分支与目标分支不能相同。", "INVALID_INPUT", 400);
    if (rule.status === "conflicted")
      throw new GitMrError("先解决当前冲突，再对调方向。", "INVALID_STATE", 409);
    await this.store.write(QUICK_MERGE_KINDS.rules, {
      ...rule,
      source,
      target,
      status: "idle",
      mrId: undefined,
      message: undefined,
      ahead: undefined,
      lastKind: undefined,
      lastAt: undefined,
    });
    return this.requireRule(projectId, ruleId);
  }

  async deleteRule(projectId: string, ruleId: string) {
    await this.requireRule(projectId, ruleId);
    await this.store.remove(QUICK_MERGE_KINDS.rules, projectId, ruleId);
  }

  private async saveRule(rule: QuickMergeRule, patch: Partial<QuickMergeRule>) {
    const next: QuickMergeRule = { ...rule, ...patch };
    await this.store.write(QUICK_MERGE_KINDS.rules, next);
    return next;
  }

  /** Fetch the source, then merge it into the target through the audited MR
   * pipeline (isolated worktree, conflict detection). Never pushes. */
  async merge(projectId: string, ruleId: string, location: WorkspaceLocation): Promise<QuickMergeRuleView> {
    const rule = await this.requireRule(projectId, ruleId);
    return this.store.exclusive(`quick-merge:${projectId}:${ruleId}`, async () => {
      const steps: QuickMergeStep[] = [];
      const repo = await inspect(location);
      try {
        steps.push(await fetchRemote(repo));
        const sync = await syncBranch(repo, rule.source);
        steps.push(syncStep(rule.source, sync));
        if (sync.state === "no-branch")
          throw new GitMrError(`源分支 ${rule.source} 不存在。`, "NO_BRANCH", 400);

        // This board is one click, so it authorizes the checked-out target itself.
        // `targetCheckout` still refuses an ambiguous, busy or dirty checkout, which
        // keeps the decision out of the user's hands without touching their drafts.
        const checkout = await this.mr.targetCheckout(location, rule.target);
        const mr = await this.mr.create(projectId, location, {
          rootId: rule.rootId,
          title: `快捷合并 ${rule.source} → ${rule.target}`,
          target: rule.target,
          sources: [rule.source],
          strategy: "merge_commit",
          allowCheckedOutTarget: checkout !== null,
        });
        const prepared = await this.mr.prepare(projectId, mr.id, mr.version);
        const first = prepared.steps[0];
        if (prepared.status === "conflicted") {
          steps.push({
            command: `git merge ${rule.source}`,
            status: "failed",
            detail: `${rule.target} 存在冲突，需要解决`,
          });
          const saved = await this.saveRule(rule, {
            status: "conflicted",
            mrId: prepared.id,
            lastKind: "merge",
            lastAt: new Date().toISOString(),
            message: "合并冲突，需要解决",
            ahead: undefined,
          });
          return { ...saved, steps };
        }
        if (prepared.status !== "ready") {
          steps.push({
            command: `git merge ${rule.source}`,
            status: "failed",
            detail: prepared.error ?? `合并状态：${prepared.status}`,
          });
          await this.saveRule(rule, {
            status: "failed",
            mrId: prepared.id,
            lastKind: "merge",
            lastAt: new Date().toISOString(),
            message: prepared.error ?? "合并未完成",
          });
          throw new GitMrError(prepared.error ?? "合并未完成。", "MERGE_INCOMPLETE", 409);
        }
        if (first?.status === "noop") {
          steps.push({ command: `git merge ${rule.source}`, status: "skipped", detail: "来源已包含在目标中" });
          const saved = await this.saveRule(rule, {
            status: "merged",
            mrId: prepared.id,
            lastKind: "merge",
            lastAt: new Date().toISOString(),
            message: "无需合并",
            ahead: await aheadOfRemote(repo, rule.target),
          });
          return { ...saved, steps };
        }
        await this.mr.finalize(projectId, prepared.id, prepared.version, { skipChecks: true });
        steps.push({
          command: `git merge ${rule.source}`,
          status: "ok",
          detail: checkout
            ? `已合入 ${rule.target}（检出工作树内快进）`
            : `已合入 ${rule.target}`,
        });
        const ahead = await aheadOfRemote(repo, rule.target);
        const saved = await this.saveRule(rule, {
          status: "merged",
          mrId: prepared.id,
          lastKind: "merge",
          lastAt: new Date().toISOString(),
          message: ahead ? `已合并 · 待推送 ${ahead}` : "已合并",
          ahead,
        });
        return { ...saved, steps };
      } catch (error) {
        if (error instanceof GitMrError && error.code === "DIVERGED") throw error;
        const message = mergeFailure(error, rule.target);
        await this.saveRule(rule, {
          status: "failed",
          lastKind: "merge",
          lastAt: new Date().toISOString(),
          message,
        }).catch(() => undefined);
        if (error instanceof GitMrError && error.code === "BRANCH_POLICY")
          throw new GitMrError(message, "BRANCH_POLICY", 400);
        throw error instanceof GitMrError && EXPLAINED.has(error.code)
          ? new GitMrError(message, error.code, error.status)
          : error;
      }
    });
  }

  /** Pull the target, then push it without force. Divergence is reported, never overwritten. */
  async push(projectId: string, ruleId: string, location: WorkspaceLocation): Promise<QuickMergeRuleView> {
    const rule = await this.requireRule(projectId, ruleId);
    if (rule.status === "conflicted")
      throw new GitMrError("先解决冲突，再推送。", "INVALID_STATE", 409);
    return this.store.exclusive(`quick-merge:${projectId}:${ruleId}`, async () => {
      const repo = await inspect(location);
      try {
        const result = await pushBranch(repo, rule.target);
        const saved = await this.saveRule(rule, {
          status: "pushed",
          lastKind: "push",
          lastAt: new Date().toISOString(),
          message: result.pushed ? "已推送 · 与远端同步" : "远端已是最新",
          ahead: 0,
        });
        return { ...saved, steps: result.steps };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await this.saveRule(rule, {
          status: "failed",
          lastKind: "push",
          lastAt: new Date().toISOString(),
          message,
        }).catch(() => undefined);
        throw error;
      }
    });
  }
}

export const quickMergeService = new QuickMergeService();
