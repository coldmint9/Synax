import { useEffect, useState } from "react";

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
 * to its dim state; the timer still ticks (see index.css).
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
  Drive: { delays: chevron, dur: 650, round: false },
  Dots: { delays: chevron, dur: 650, round: true },
  Orbit: { delays: orbit, dur: 950, round: false },
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
            round ? "rounded-full" : "rounded-[1px]"
          }`}
          style={{
            opacity: delay === null ? 0.07 : 0.15,
            animation:
              delay === null
                ? "none"
                : `pixel-on ${dur}ms ease-in-out ${delay}ms infinite`,
          }}
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

/** Elapsed time only (no grid, no label) — minimal left-aligned round footer. */
export function ElapsedTimer() {
  const elapsed = useElapsed();
  return (
    <span
      role="timer"
      className="inline-block px-1 py-2 font-mono text-[12px] tabular-nums text-muted-foreground"
    >
      {elapsed}
    </span>
  );
}

function useElapsed() {
  const [ds, setDs] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setDs((d) => d + 1), 100);
    return () => clearInterval(t);
  }, []);
  const total = ds / 10;
  if (total < 60) return `${total.toFixed(1)}s`;
  return `${Math.floor(total / 60)}m ${(total % 60).toFixed(1)}s`;
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
          className="loading-state-label bg-clip-text text-[13px] font-medium text-transparent"
          style={{
            backgroundImage:
              "linear-gradient(90deg, var(--muted-foreground) 35%, var(--foreground) 50%, var(--muted-foreground) 65%)",
            backgroundSize: "200% 100%",
            animation: "shimmer-text 1.4s linear infinite",
          }}
        >
          {label}
        </span>
      )}
    </div>
  );
}
