import { useEffect, useState } from "react";
import { readStreamedTokens } from "../../../lib/streamThroughput";

/** Sampling window for the live throughput readout. */
export const TOKEN_RATE_SAMPLE_MS = 5_000;

/**
 * Live output-throughput estimate, measured in the renderer from the stream the
 * store already consumes — no extra request and no polling lag.
 *
 * Sampling runs only while `working`: an idle session keeps no timer and
 * reports null, so the panel never shows a stale or invented speed. A window
 * that produced no output (tool execution, approval wait) keeps the previous
 * measurement instead of flickering to zero.
 */
export function useSessionTokenRate(
  sessionId: string | null,
  working: boolean,
): number | null {
  const [rate, setRate] = useState<number | null>(null);
  useEffect(() => {
    setRate(null);
    if (!sessionId || !working) return;
    let previous = readStreamedTokens(sessionId);
    let previousAt = Date.now();
    const timer = window.setInterval(() => {
      const now = Date.now();
      const total = readStreamedTokens(sessionId);
      const elapsed = (now - previousAt) / 1000;
      const delta = total - previous;
      previous = total;
      previousAt = now;
      if (elapsed > 0 && delta > 0) setRate(delta / elapsed);
    }, TOKEN_RATE_SAMPLE_MS);
    return () => window.clearInterval(timer);
  }, [sessionId, working]);
  return rate;
}
