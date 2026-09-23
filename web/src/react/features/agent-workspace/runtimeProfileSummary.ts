import type {
  AgentSessionStatus,
  SessionStats,
} from "../../../lib/api/agentRuntime";
import { contextUsage } from "./ContextCompositionBar";

const STATES: Record<
  AgentSessionStatus | "idle",
  { zh: string; en: string; tone: string; hint?: [string, string] }
> = {
  idle: { zh: "未开始", en: "Not started", tone: "neutral" },
  queued: { zh: "排队中", en: "Queued", tone: "neutral" },
  running: { zh: "运行中", en: "Running", tone: "running" },
  stopping: { zh: "停止中", en: "Stopping", tone: "warning" },
  waiting_permission: {
    zh: "待确认",
    en: "Approval needed",
    tone: "warning",
    hint: ["请在会话中确认操作", "Approve the action in the conversation"],
  },
  waiting_input: {
    zh: "待输入",
    en: "Input needed",
    tone: "warning",
    hint: ["需要你的补充信息", "Your input is needed"],
  },
  completed: { zh: "已完成", en: "Completed", tone: "neutral" },
  failed: {
    zh: "失败",
    en: "Failed",
    tone: "danger",
    hint: [
      "执行失败，请查看会话消息",
      "Execution failed. See the conversation",
    ],
  },
  interrupted: {
    zh: "已中断",
    en: "Interrupted",
    tone: "warning",
    hint: [
      "执行已中断，可在会话中继续",
      "Execution interrupted. Continue in the conversation",
    ],
  },
  cancelled: { zh: "已取消", en: "Cancelled", tone: "neutral" },
};

export function runtimeProfileSummary(
  stats: SessionStats | null,
  status: AgentSessionStatus | undefined,
  zh: boolean,
) {
  const current = STATES[status ?? stats?.status ?? "idle"] ?? STATES.idle;
  const usage = contextUsage(stats?.context);
  const available =
    usage.available && Number.isFinite(usage.total) && usage.total >= 0;
  const limit =
    stats &&
    stats.contextLimitKnown !== false &&
    Number.isFinite(stats.contextLimit) &&
    stats.contextLimit > 0
      ? stats.contextLimit
      : null;
  const percent =
    available && limit !== null ? (usage.total / limit) * 100 : null;
  const stale = available && stats?.context?.stale === true;
  const high = percent !== null && percent >= 85 && !stale;
  const hint =
    current.hint?.[zh ? 0 : 1] ??
    (high ? (zh ? "上下文接近上限" : "Context nearly full") : null);
  return {
    ...usage,
    available,
    limit,
    percent,
    stale,
    high,
    hint,
    label: zh ? current.zh : current.en,
    tone: current.tone,
    hintTone: current.hint ? current.tone : "warning",
  };
}
