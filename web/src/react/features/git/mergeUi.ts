import type {
  MergeRequest,
  MergeStatus,
  MergeRequestInput,
} from "../../../lib/api/gitMr";
export const statusLabels: Record<MergeStatus, string> = {
  draft: "草稿",
  preparing: "准备中",
  conflicted: "有冲突",
  ready: "待完成",
  checking: "检查中",
  check_failed: "检查失败",
  applying: "更新目标中",
  merged: "已合并",
  noop: "无需合并",
  cancelled: "已取消",
  failed: "失败",
  interrupted: "已中断",
};
export const isTerminal = (status: MergeStatus) =>
  ["merged", "noop", "cancelled"].includes(status);
export const isRunning = (status: MergeStatus) =>
  ["preparing", "checking", "applying"].includes(status);
export function canFinalize(mr: MergeRequest): boolean {
  return (
    mr.status === "ready" &&
    !!mr.candidateTree &&
    mr.checks.every((check) => {
      const result = [...mr.checkResults]
        .reverse()
        .find((item) => item.id === check.id);
      return result?.status === "passed" && result.tree === mr.candidateTree;
    })
  );
}
export function validateInput(input: MergeRequestInput): string | null {
  if (!input.title.trim()) return "请填写合并请求标题。";
  if (!input.target) return "请选择目标分支。";
  if (!input.sources.length) return "请至少选择一个源分支。";
  if (input.sources.includes(input.target)) return "源分支不能与目标分支相同。";
  if (new Set(input.sources).size !== input.sources.length)
    return "源分支不能重复。";
  if (
    input.target.startsWith("feature") &&
    input.sources.some((source) => source === "test" || source === "beta")
  )
    return "不能将 test 或 beta 合入 feature 分支。";
  return null;
}
export function moveSource(
  sources: string[],
  index: number,
  direction: -1 | 1,
): string[] {
  const next = [...sources];
  const destination = index + direction;
  if (destination < 0 || destination >= next.length) return next;
  [next[index], next[destination]] = [next[destination], next[index]];
  return next;
}
