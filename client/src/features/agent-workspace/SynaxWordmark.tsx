import { useEffect, useRef } from "react";
import { loadMotion, reducedMotion } from "../../shared/design/motion";
import "./newSessionWelcome.css";

// SYNAX, drawn with text blocks. Double-width cells keep the letters proportionate.
const BLOCK_WORDMARK = [
  ["01111", "10001", "10001", "01110", "10001"],
  ["10000", "10001", "11001", "10001", "10001"],
  ["10000", "01010", "11001", "10001", "01010"],
  ["01110", "00100", "10101", "11111", "00100"],
  ["00001", "00100", "10011", "10001", "01010"],
  ["00001", "00100", "10011", "10001", "10001"],
  ["11110", "00100", "10001", "10001", "10001"],
].map((row) => row.map((letter) => letter.replace(/1/g, "██").replace(/0/g, "  ")).join("  ")).join("\n");

export function SynaxWordmark({
  compact = false,
  animate = true,
}: {
  compact?: boolean;
  animate?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (compact || !animate) return;
    const element = ref.current;
    const frame = element?.querySelector<HTMLElement>("[data-ascii-style]");
    if (!element || !frame) return;

    let active = true;
    let generation = 0;
    let stop = () => {};
    let syncPlayback = () => {};
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const start = () => {
      const request = ++generation;
      if (reducedMotion()) return;
      void loadMotion().then((gsap) => {
        if (!active || request !== generation || media.matches) return;
        const context = gsap.context(() => {
          // Only the glow layer breathes; the text stays sharp and never moves or fades.
          const breathing = gsap.to(frame, {
            "--synax-glow-opacity": 0.85,
            duration: 2.8,
            repeat: -1,
            yoyo: true,
            ease: "sine.inOut",
            paused: document.hidden,
          });
          syncPlayback = () => { breathing.paused(document.hidden); };
        }, element);
        stop = () => {
          syncPlayback = () => {};
          context.revert();
          frame.style.removeProperty("--synax-glow-opacity");
        };
      }).catch(() => { /* The block wordmark keeps its static glow without GSAP. */ });
    };
    const changeMotion = () => { stop(); start(); };
    const visibility = () => syncPlayback();
    media.addEventListener("change", changeMotion);
    document.addEventListener("visibilitychange", visibility);
    start();
    return () => {
      active = false;
      media.removeEventListener("change", changeMotion);
      document.removeEventListener("visibilitychange", visibility);
      stop();
    };
  }, [compact, animate]);

  return (
    <div
      ref={ref}
      className={`synax-wordmark${compact ? " synax-wordmark--compact" : ""}`}
      role="img"
      aria-label="Synax"
    >
      <div data-ascii-stage="" className="synax-ascii-stage" aria-hidden="true">
        <pre className="synax-ascii-frame" data-ascii-style="blocks" data-ascii-art={BLOCK_WORDMARK}>
          {BLOCK_WORDMARK}
        </pre>
      </div>
    </div>
  );
}
