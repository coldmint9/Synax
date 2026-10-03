import { useEffect, useState } from "react";
import { useLocale } from "../../shared/hooks/useLocale";

const ASCII_FRAMES = [
  "<~*~>",
  "[=~=]",
  "{✦·✦}",
  "(o.O)",
  "<+.+>",
  "[:::]",
  "{^_^}",
  "<≋≋>",
  "(*_*)",
  "[>_<]",
  "{~✧~}",
  "<·°·>",
];

const PLAY_INTERVAL_MS = 420;
const REASSURANCE_AFTER_MS = 3_000;
const NETWORK_HINT_AFTER_MS = 20_000;

function randomFrame(previous: string) {
  const candidates = ASCII_FRAMES.filter((frame) => frame !== previous);
  return candidates[Math.floor(Math.random() * candidates.length)] ?? ASCII_FRAMES[0];
}

export function ThinkingIndicator({
  label: customLabel,
}: {
  label?: string;
}) {
  const { t } = useLocale();
  const label = customLabel ?? t("sessionPendingThinking");
  const [phase, setPhase] = useState<"initial" | "reassure" | "network">(
    "initial",
  );
  const [frame, setFrame] = useState(ASCII_FRAMES[0]);

  useEffect(() => {
    const frameTimer = setInterval(() => {
      setFrame((current) => randomFrame(current));
    }, PLAY_INTERVAL_MS);
    const reassureTimer = setTimeout(
      () => setPhase("reassure"),
      REASSURANCE_AFTER_MS,
    );
    const networkTimer = setTimeout(
      () => setPhase("network"),
      NETWORK_HINT_AFTER_MS,
    );
    return () => {
      clearInterval(frameTimer);
      clearTimeout(reassureTimer);
      clearTimeout(networkTimer);
    };
  }, []);

  const message =
    phase === "network"
      ? t("sessionPendingNetworkHint")
      : phase === "reassure"
        ? t("sessionPendingReassurance")
        : "";

  return (
    <div
      role="status"
      aria-label={`${label}. ${message}`.trim()}
      aria-live="polite"
      data-phase={phase}
      data-testid="thinking-indicator"
      className="ascii-thinking-indicator"
    >
      <span aria-hidden="true" className="ascii-thinking-art">
        {frame}
        {message ? <span className="ascii-thinking-message"> {message}</span> : null}
      </span>
      <span className="sr-only">{label}. {message}</span>
    </div>
  );
}
