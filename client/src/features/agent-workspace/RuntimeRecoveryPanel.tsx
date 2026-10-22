import type { AgentSession } from "../../adapters/transport/agentRuntime";
import { useLocale } from "../../shared/hooks/useLocale";

/** Recovery is automatic; this only explains a fence the runtime is still
 * settling. It intentionally offers no action: the next message retries cleanup. */
export function RuntimeRecoveryPanel({ session }: { session: AgentSession }) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const control = session.sessionMetadata?.runtimeControl as
    | { state?: string; reason?: string }
    | undefined;
  if (control?.state !== "unconfirmed") return null;
  return (
    <section
      aria-label={zh ? "执行恢复" : "Execution recovery"}
      className="mb-3 space-y-2 rounded-lg border border-warning/40 bg-warning/5 p-3 text-xs"
    >
      <p className="font-medium">
        {zh ? "上次执行已中断" : "Previous execution was interrupted"}
      </p>
      <p className="text-muted-foreground">{control.reason}</p>
      <p className="text-muted-foreground">
        {zh
          ? "残留进程正在自动清理，无需操作；发送新消息时会再次尝试。"
          : "Residual processes are cleaned up automatically; sending a message retries it."}
      </p>
    </section>
  );
}
