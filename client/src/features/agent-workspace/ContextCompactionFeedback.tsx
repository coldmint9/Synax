import { Check, TriangleAlert } from "lucide-react";
import type { ContextCompactionState } from "../../adapters/transport/agentRuntime";
import { useLocale } from "../../shared/hooks/useLocale";
import { StatusIndicator } from "../../shared/ui/StatusIndicator";

/** A durable transcript row, not a dismissible notification. */
export function ContextCompactionFeedback({
  state,
}: {
  state: ContextCompactionState;
}) {
  const zh = useLocale().locale === "zh";
  if (state.status === "running")
    return (
      <StatusIndicator active label={zh ? "正在压缩上下文" : "Compacting context"} />
    );
  const failed = state.status === "failed";
  const label = failed
    ? zh
      ? "上下文压缩失败"
      : "Context compaction failed"
    : state.compacted
      ? zh
        ? state.checkpointId ? "此前上下文已压缩" : "上下文已压缩"
        : state.checkpointId ? "Earlier context compacted" : "Context compacted"
      : zh
        ? "上下文无需进一步压缩"
        : "No further context reduction";
  const Icon = failed ? TriangleAlert : Check;
  return (
    <StatusIndicator
      role={failed ? "alert" : "status"}
      tone={failed ? "danger" : "neutral"}
      icon={<Icon size={14} />}
      label={`${label}${failed && state.error ? `：${state.error}` : ""}`}
      description={!failed && state.compacted && state.checkpointId ? (
        <span>{zh ? "历史仍可查看，不再支持编辑、回滚或分叉" : "History remains readable; editing, rollback and forking are unavailable"}</span>
      ) : undefined}
      meta={!failed && state.compressedTokens !== undefined ? (
        <span
          className="tabular-nums"
          title={
            zh
              ? "压缩后的本地上下文估算，不含完整系统提示"
              : "Local context estimate, excluding the full system prompt"
          }
        >
          · {state.compressedTokens.toLocaleString()} tokens{" "}
          {zh ? "（估算）" : "(estimated)"}
        </span>
      ) : undefined}
    />
  );
}
