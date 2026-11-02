import { RotateCw, WifiOff } from "lucide-react";
import { useLocale } from "../../shared/hooks/useLocale";
import type { AutoResumeItem } from "../../adapters/transport/agentRuntime";
import { PixelLoader } from "./LoadingState";

/**
 * Row-level state of the runtime's automatic continuation.
 *
 * The list is where the user looks for "is my work still running", so the queue
 * shows up there instead of in a banner: a loader while a continuation is being
 * submitted, a broken link while the model endpoint is unreachable, and a retry
 * glyph while a failed attempt waits for its backoff.
 */
export function SessionAutoResumeIndicator({ item }: { item: AutoResumeItem }) {
  const { t } = useLocale();
  if (item.phase === "waiting_network")
    return (
      <span
        className="session-list-auto-resume"
        data-phase={item.phase}
        title={t("sessionAutoResumeWaitingNetwork")}
      >
        <WifiOff size={12} aria-hidden="true" />
        <span className="sr-only">{t("sessionAutoResumeWaitingNetwork")}</span>
      </span>
    );
  if (item.phase === "retrying")
    return (
      <span
        className="session-list-auto-resume"
        data-phase={item.phase}
        title={t("sessionAutoResumeRetrying", { count: Math.max(1, item.attempts) })}
      >
        <RotateCw size={12} aria-hidden="true" />
        <span className="sr-only">
          {t("sessionAutoResumeRetrying", { count: Math.max(1, item.attempts) })}
        </span>
      </span>
    );
  return (
    <span
      className="session-list-auto-resume"
      data-phase={item.phase}
      title={t("sessionAutoResumeQueued")}
    >
      <PixelLoader />
      <span className="sr-only">{t("sessionAutoResumeQueued")}</span>
    </span>
  );
}
