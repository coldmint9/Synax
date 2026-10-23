import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

/**
 * 这些区域里的错误必须留在原地：它们要么是对话/横幅这类"仍然有用的上下文"，
 * 要么是输入校验。桥接会把未标记的 role="alert" 提升成浮层并隐藏源节点，
 * 所以这里用静态守卫防止有人后续又加回一个没标记的。
 */
const PROTECTED_SOURCES = [
  "src/features/agent-workspace/TimelineEntryView.tsx",
  "src/features/agent-workspace/RetryIndicator.tsx",
  "src/features/agent-workspace/SessionTranscript.tsx",
  "src/features/agent-workspace/SessionHistoryContext.tsx",
  "src/features/agent-workspace/SessionCommitDialog.tsx",
  "src/features/agent-workspace/SessionComposer.tsx",
  "src/features/agent-workspace/WorkspaceDirectoryTree.tsx",
  "src/features/agent-workspace/GlobalSessionSearch.tsx",
  "src/features/agent-workspace/PlanHistoryPanel.tsx",
  "src/features/agent-workspace/SubagentReadonlyView.tsx",
  "src/features/agent-workspace/InputQueueStrip.tsx",
  "src/features/agent-workspace/dock/AgentDockDialog.tsx",
  "src/features/agent-workspace/dock/AgentQuickApproval.tsx",
  "src/features/agent-workspace/HistoricalVisualizationReply.tsx",
  "src/features/media/MediaGenerationControls.tsx",
  "src/features/skills/SkillMarketSidebar.tsx",
  "src/features/visualizations/InlineVisualization.tsx",
  "src/shared/ui/ui/Field.tsx",
];

const ALERT_TAG = /<[a-zA-Z][^>]*\brole="alert"[^>]*>/g;

// client/src/shared/ui/ → client/
const clientRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

it("keeps every protected alert region opted out of the global toast", () => {
  const problems: string[] = [];

  for (const relativePath of PROTECTED_SOURCES) {
    const source = readFileSync(resolve(clientRoot, relativePath), "utf8");
    const tags = source.match(ALERT_TAG) ?? [];
    if (tags.length === 0) {
      problems.push(`${relativePath}: 未找到 role="alert"，请同步更新守卫清单`);
      continue;
    }
    for (const tag of tags) {
      if (!tag.includes('data-error-toast="off"')) {
        problems.push(`${relativePath}: ${tag.replace(/\s+/g, " ")}`);
      }
    }
  }

  expect(problems).toEqual([]);
});
