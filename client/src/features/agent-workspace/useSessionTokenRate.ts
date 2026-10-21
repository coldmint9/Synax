import { useEffect, useState } from "react";
import { readStreamedTokenRate } from "../../shared/lib/streamThroughput";

/** Readout cadence. Event timestamps define the rolling generation window. */
export const TOKEN_RATE_SAMPLE_MS = 250;

/**
 * Live output-throughput estimate, measured in the renderer from the stream the
 * store already consumes — no extra request and no polling lag.
 *
 * Sampling runs only while `working`: an idle session keeps no timer and
 * reports null, so the panel never shows a stale or invented speed. A window
 * that produced no output (tool execution, approval wait) clears the reading
 * instead of showing a stale speed.
 */
export function useSessionTokenRate(
  sessionId: string | null,
  working: boolean,
): number | null {
  const [rate, setRate] = useState<number | null>(null);
  useEffect(() => {
    setRate(null);
    if (!sessionId || !working) return;
    setRate(readStreamedTokenRate(sessionId));
    const timer = window.setInterval(() => {
      setRate(readStreamedTokenRate(sessionId));
    }, TOKEN_RATE_SAMPLE_MS);
    return () => window.clearInterval(timer);
  }, [sessionId, working]);
  return rate;
}
