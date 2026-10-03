import { Check, TriangleAlert } from "lucide-react";
import type { ContextCompactionState } from "../../adapters/transport/agentRuntime";
import { useLocale } from "../../shared/hooks/useLocale";
import { ThinkingIndicator } from "./ThinkingIndicator";

/** A durable transcript row, not a dismissible notification. */
export function ContextCompactionFeedback({
  state,
}: {
  state: ContextCompactionState;
}) {
  const zh = useLocale().locale === "zh";
  if (state.status === "running")
    return (
      <ThinkingIndicator label={zh ? "正在压缩上下文" : "Compacting context"} />
    );
  const failed = state.status === "failed";
  const label = failed
    ? zh
      ? "上下文压缩失败"
      : "Context compaction failed"
    : state.compacted
      ? zh
        ? "上下文已压缩"
        : "Context compacted"
      : zh
        ? "上下文无需进一步压缩"
        : "No further context reduction";
  const Icon = failed ? TriangleAlert : Check;
  return (
    <div
      role={failed ? "alert" : "status"}
      className={`flex items-center gap-2 px-1 py-2 text-xs ${failed ? "text-danger" : "text-muted-foreground"}`}
    >
      <Icon size={14} aria-hidden="true" />
      <span>
        {label}
        {failed && state.error ? `：${state.error}` : ""}
      </span>
      {!failed && state.compressedTokens !== undefined && (
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
      )}
    </div>
  );
}
