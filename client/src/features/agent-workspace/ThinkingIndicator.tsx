import { useEffect, useState } from "react";
import { useLocale } from "../../shared/hooks/useLocale";
import { StatusIndicator } from "../../shared/ui/StatusIndicator";

const REASSURANCE_AFTER_MS = 3_000;
const NETWORK_HINT_AFTER_MS = 20_000;

function PendingResponseIndicator() {
  const { t } = useLocale();
  const [phase, setPhase] = useState<"initial" | "reassure" | "network">(
    "initial",
  );

  useEffect(() => {
    const reassureTimer = setTimeout(
      () => setPhase("reassure"),
      REASSURANCE_AFTER_MS,
    );
    const networkTimer = setTimeout(
      () => setPhase("network"),
      NETWORK_HINT_AFTER_MS,
    );
    return () => {
      clearTimeout(reassureTimer);
      clearTimeout(networkTimer);
    };
  }, []);

  return (
    <StatusIndicator
      active
      label={phase === "initial" ? t("sessionPendingThinking") : t("sessionPendingReassurance")}
      description={phase === "network" ? t("sessionPendingNetworkHint") : undefined}
      announcement={phase === "network" ? `${t("sessionPendingThinking")} · ${t("sessionPendingNetworkHint")}` : undefined}
      data-phase={phase}
      data-testid="thinking-indicator"
    />
  );
}

export function ThinkingIndicator({ label }: { label?: string }) {
  // Explicit operation labels must not become generic model/network hints.
  return label != null
    ? <StatusIndicator active label={label} data-testid="thinking-indicator" />
    : <PendingResponseIndicator />;
}
