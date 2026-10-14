import { useEffect, useState } from "react";
import type { CSSProperties } from "react";

/* ─────────────────────────────────────────────────────────
 * LOADING STATE — pixel-grid loader for long-running work
 *
 * Variants:
 *   Drive — square cells, chevron wavefront driving right;
 *           the 650ms cycle is shorter than the sweep, so
 *           two fronts are always in flight
 *   Dots  — same wavefront, circular cells
 *   Orbit — a comet lapping the grid perimeter
 *
 * Paired with a shimmering label and a live elapsed timer
 * in mono tabular figures. Reduced motion freezes the grid
 * in place; the clock is shared and stops when hidden or disconnected.
 * ───────────────────────────────────────────────────────── */

const chevron = Array.from({ length: 9 }, (_, i) => {
  const r = Math.floor(i / 3);
  const c = i % 3;
  return (c + Math.abs(r - 1)) * 90;
});

const ORBIT_ORDER = [0, 1, 2, 5, 8, 7, 6, 3];
const orbit = Array.from({ length: 9 }, (_, i) => {
  const k = ORBIT_ORDER.indexOf(i);
  return k === -1 ? null : k * 110;
});

const PATTERNS: Record<
  string,
  { delays: (number | null)[]; dur: number; round: boolean }
> = {
  Drive: { delays: chevron, dur: 420, round: false },
  Dots: { delays: chevron, dur: 420, round: true },
  Orbit: { delays: orbit, dur: 620, round: false },
  Thinking: { delays: chevron, dur: 720, round: false },
};

function LoaderGrid({
  delays,
  dur,
  round,
}: {
  delays: (number | null)[];
  dur: number;
  round: boolean;
}) {
  return (
    <span
      aria-hidden
      className="grid shrink-0 grid-cols-[repeat(3,4px)] gap-[1.5px]"
    >
      {delays.map((delay, index) => (
        <span
          key={index}
          className={`loading-state-cell h-[4px] w-[4px] bg-foreground ${
            delay === null ? "loading-state-cell--static" : ""
          } ${
            round ? "rounded-full" : "rounded-[1px]"
          }`}
          style={
            {
              "--loading-delay": `${delay ?? 0}ms`,
              "--loading-duration": `${dur}ms`,
            } as CSSProperties
          }
        />
      ))}
    </span>
  );
}

/** Ready-made pixel loader for icon slots (e.g. the work-log round header). */
export function PixelLoader({ variant = "Drive" }: { variant?: string }) {
  const { delays, dur, round } = PATTERNS[variant] ?? PATTERNS.Drive;
  return <LoaderGrid delays={delays} dur={dur} round={round} />;
}

function useElapsed() {
  const [seconds, setSeconds] = useState(0);
  useEffect(() => {
    // The label has no sub-second precision, so a 1Hz update avoids
    // scheduling ten React renders per second for every mounted loader.
    const t = setInterval(() => setSeconds((value) => value + 1), 1000);
    return () => clearInterval(t);
  }, []);
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${seconds % 60}s`;
}

export default function LoadingState({
  label,
  variant = "Drive",
}: {
  label?: string;
  variant?: string;
}) {
  const elapsed = useElapsed();
  const { delays, dur, round } = PATTERNS[variant] ?? PATTERNS.Drive;

  return (
    <div
      role="status"
      aria-label={label}
      className="flex w-fit items-center gap-2.5 px-1 py-2"
    >
      <LoaderGrid delays={delays} dur={dur} round={round} />
      <span className="font-mono text-[12px] tabular-nums text-muted-foreground">
        {elapsed}
      </span>
      {label && (
        <span
          className="loading-state-label text-[13px] font-medium text-muted-foreground"

        >
          {label}
        </span>
      )}
    </div>
  );
}
