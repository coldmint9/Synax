import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { ReasoningEffort } from "../../../adapters/transport/agentRuntime";
import { ALL_REASONING_EFFORTS, REASONING_EFFORT_LABELS } from "../../settings/lib/providerPresets";

const PROFILES = {
  none: { glyphs: ".", speed: 1, density: .12, glow: 0, count: 1, travel: 8 },
  low: { glyphs: ".:,;", speed: 2, density: .32, glow: .12, count: 3, travel: 16 },
  medium: { glyphs: ".:;+=", speed: 4, density: .48, glow: .24, count: 5, travel: 24 },
  high: { glyphs: ":+=x*#", speed: 7, density: .65, glow: .42, count: 8, travel: 36 },
  xhigh: { glyphs: "+x*#%@", speed: 11, density: .82, glow: .64, count: 12, travel: 48 },
  max: { glyphs: ":+=x*#%@", speed: 17, density: .95, glow: .92, count: 16, travel: 64 },
} satisfies Record<ReasoningEffort, object>;

interface Props {
  effort: ReasoningEffort;
  levels: ReasoningEffort[];
  label: string;
  disabled?: boolean;
  onChange: (effort: ReasoningEffort) => void;
}

interface Particle {
  x: number;
  y: number;
  vx: number;
  vy: number;
  born: number;
  life: number;
}

function useReducedMotion() {
  const [reduced, setReduced] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  useEffect(() => {
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const update = () => setReduced(media.matches);
    update();
    media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  return reduced;
}

export function ComposerEffortControl({ effort, levels, label, disabled, onChange }: Props) {
  const reduced = useReducedMotion();
  const [dragging, setDragging] = useState(false);
  const railRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const titleRef = useRef<HTMLDivElement>(null);
  const entryRef = useRef<HTMLDivElement>(null);
  const ringRef = useRef<HTMLSpanElement>(null);
  const previousRef = useRef(effort);
  const impactRef = useRef(0);
  const emittedImpactRef = useRef(0);
  const index = Math.max(0, levels.indexOf(effort));
  const ratio = levels.length <= 1 ? .5 : index / (levels.length - 1);
  const mode = reduced || disabled ? "idle" : effort === "max" ? "loop" : dragging ? "drag" : "idle";

  useEffect(() => {
    const end = () => setDragging(false);
    window.addEventListener("pointerup", end);
    window.addEventListener("pointercancel", end);
    window.addEventListener("blur", end);
    return () => {
      window.removeEventListener("pointerup", end);
      window.removeEventListener("pointercancel", end);
      window.removeEventListener("blur", end);
    };
  }, []);

  useLayoutEffect(() => {
    const previous = previousRef.current;
    previousRef.current = effort;
    const entry = entryRef.current;
    const title = titleRef.current;
    const rail = railRef.current;
    const ring = ringRef.current;
    if (previous === effort || reduced || disabled || !entry || !title || !rail || !ring) return;
    const animations: Animation[] = [];
    let outgoing: HTMLElement | null = null;
    if (entry.animate) {
      // Clone only the visual layer; the live label announces the new level once.
      outgoing = entry.cloneNode(true) as HTMLElement;
      outgoing.classList.add("composer-effort-title-ghost");
      outgoing.classList.toggle("is-max", previous === "max");
      outgoing.querySelector<HTMLElement>(".composer-effort-title-text")!.textContent = previous;
      title.appendChild(outgoing);
      const direction = Math.sign(ALL_REASONING_EFFORTS.indexOf(effort) - ALL_REASONING_EFFORTS.indexOf(previous));
      const options = { duration: 280, easing: "cubic-bezier(.22,.7,.22,1)" };
      const exit = outgoing.animate([
        { transform: "translateX(0)", opacity: 1 },
        { transform: `translateX(${-direction * 48}px)`, opacity: 0 },
      ], options);
      animations.push(exit, entry.animate([
        { transform: `translateX(${direction * 48}px)`, opacity: 0 },
        { transform: "translateX(0)", opacity: 1 },
      ], options));
      const ghost = outgoing;
      exit.finished.then(() => ghost.remove(), () => ghost.remove());
    }
    if (effort === "max") {
      impactRef.current = performance.now();
      if (ring.animate) {
        animations.push(ring.animate([
          { transform: "scale(.8)", opacity: .9 },
          { transform: "scale(3.2)", opacity: 0 },
        ], { duration: 650, easing: "cubic-bezier(.15,.6,.25,1)" }));
        animations.push(rail.animate([
          { boxShadow: "0 0 0 0 transparent" },
          { boxShadow: "0 0 22px 3px color-mix(in srgb, var(--accent) 40%, transparent)", offset: .18 },
          { boxShadow: "0 0 0 0 transparent" },
        ], { duration: 700, easing: "ease-out" }));
      }
    }
    return () => {
      animations.forEach(animation => animation.cancel());
      outgoing?.remove();
    };
  }, [effort, reduced, disabled]);

  useEffect(() => {
    const canvas = canvasRef.current;
    const rail = railRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !rail || !context) return;
    const profile = PROFILES[effort];
    let width = 214;
    let height = 56;
    let frame = 0;
    let lastPaint = -Infinity;
    let lastBurst = -Infinity;
    let particles: Particle[] = [];
    const active = mode !== "idle";

    function paint(now: number, animated: boolean) {
      if (!context || !rail || !canvas) return;
      context.clearRect(0, 0, width, height);
      const color = getComputedStyle(canvas).color;
      const columns = Math.max(9, Math.min(33, Math.floor((width - 24) / 8)));
      const step = (width - 24) / columns;
      const phase = animated ? now / 1000 * profile.speed : 0;
      context.font = "500 11px ui-monospace, SFMono-Regular, Consolas, monospace";
      context.textAlign = "center";
      context.textBaseline = "middle";
      context.fillStyle = color;
      context.shadowColor = color;
      for (let row = 0; row < 3; row++) {
        for (let col = 0; col < columns; col++) {
          const signal = (Math.sin(col * .62 - phase + row * 1.7) + Math.cos(col * .29 + phase * .7 - row * 2.1) + 2) / 4;
          const lit = col <= Math.round((columns - 1) * ratio);
          const dense = signal > 1 - profile.density;
          const glyph = dense ? profile.glyphs[Math.min(profile.glyphs.length - 1, Math.floor(signal * profile.glyphs.length))] : ".";
          context.globalAlpha = lit ? .35 + signal * .65 : .12 + signal * .17;
          context.shadowBlur = lit ? 3 + profile.glow * 8 : 0;
          context.fillText(glyph, 12 + (col + .5) * step, height / 2 + (row - 1) * 14);
        }
      }
      context.shadowBlur = 0;
      if (animated && now - lastBurst > 160 - ALL_REASONING_EFFORTS.indexOf(effort) * 19) {
        lastBurst = now;
        const x = effort === "max" && !dragging ? 16 + Math.random() * (width - 32) : 28 + (width - 56) * ratio;
        for (let i = 0; i < profile.count; i++) {
          particles.push({ x, y: height / 2 + (Math.random() - .5) * 22, vx: (Math.random() - .5) * profile.travel, vy: (Math.random() - .5) * profile.travel, born: now, life: 280 + Math.random() * 280 });
        }
      }
      if (animated && effort === "max" && impactRef.current > emittedImpactRef.current) {
        emittedImpactRef.current = impactRef.current;
        for (let i = 0; i < 42; i++) {
          const angle = i / 42 * Math.PI * 2;
          particles.push({ x: width - 28, y: height / 2, vx: Math.cos(angle) * 64, vy: Math.sin(angle) * 32, born: now, life: 520 });
        }
      }
      particles = particles.filter(p => now - p.born < p.life);
      for (const particle of particles) {
        const age = (now - particle.born) / particle.life;
        context.globalAlpha = (1 - age) * .85;
        context.fillRect(Math.round((particle.x + particle.vx * age) / 3) * 3, Math.round((particle.y + particle.vy * age + age * age * 14) / 3) * 3, 2, 2);
      }
      context.globalAlpha = 1;
    }
    function resize() {
      if (!canvas || !rail || !context) return;
      width = rail.clientWidth || 214;
      height = rail.clientHeight || 56;
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      context.setTransform(dpr, 0, 0, dpr, 0, 0);
      paint(performance.now(), active);
    }
    function tick(now: number) {
      frame = 0;
      if (document.hidden) return;
      if (now - lastPaint >= 1000 / (8 + ALL_REASONING_EFFORTS.indexOf(effort) * 5)) {
        paint(now, true);
        lastPaint = now;
      }
      frame = requestAnimationFrame(tick);
    }
    function visibilityChanged() {
      cancelAnimationFrame(frame);
      frame = 0;
      if (active && !document.hidden) frame = requestAnimationFrame(tick);
    }
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(rail);
    const themeObserver = new MutationObserver(() => paint(performance.now(), active));
    themeObserver.observe(document.documentElement, { attributes: true, attributeFilter: ["class", "style"] });
    document.addEventListener("visibilitychange", visibilityChanged);
    visibilityChanged();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
      themeObserver.disconnect();
      document.removeEventListener("visibilitychange", visibilityChanged);
      context.clearRect(0, 0, width, height);
    };
  }, [effort, ratio, mode, dragging]);

  return (
    <div className="composer-effort-control" data-motion={mode}>
      <h2 className="composer-effort-heading">
        <span className="sr-only" aria-live="polite">{effort}</span>
        <div ref={titleRef} className="composer-effort-title-track" aria-hidden="true">
          <div ref={entryRef} className={`composer-effort-title-item${effort === "max" ? " is-max" : ""}`}>
            <span className="composer-effort-title-text" hidden={effort === "max"}>{effort}</span>
            <span className="composer-effort-title-text" hidden={effort !== "max"}>max</span>
          </div>
        </div>
      </h2>
      <div ref={railRef} className="composer-effort-rail">
        <canvas ref={canvasRef} className="composer-effort-ascii" aria-hidden="true" />
        <span className="composer-effort-thumb" aria-hidden="true" style={{ left: ratio === .5 ? "50%" : `calc(28px + (100% - 56px) * ${ratio})` }}>#</span>
        <div className="composer-effort-impact" aria-hidden="true"><span ref={ringRef} className="composer-effort-impact-ring" /></div>
        <input
          type="range"
          className="composer-effort-range"
          min={0}
          max={Math.max(0, levels.length - 1)}
          step={1}
          value={index}
          aria-label={label}
          aria-valuetext={`${effort} (${REASONING_EFFORT_LABELS[effort]})`}
          disabled={disabled || levels.length <= 1}
          onChange={event => {
            if (disabled || levels.length <= 1) return;
            const next = levels[Number(event.currentTarget.value)];
            if (next && next !== effort) onChange(next);
          }}
          onPointerDown={event => {
            if (disabled || levels.length <= 1 || event.button !== 0) return;
            setDragging(true);
            if (event.nativeEvent.isTrusted) event.currentTarget.setPointerCapture?.(event.pointerId);
          }}
          onPointerUp={() => setDragging(false)}
          onPointerCancel={() => setDragging(false)}
          onLostPointerCapture={() => setDragging(false)}
          onBlur={() => setDragging(false)}
        />
      </div>
    </div>
  );
}
