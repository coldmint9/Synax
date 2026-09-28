import { useId, type ReactNode } from "react";
import { useGlassSurface } from "./glass/useGlassSurface";
import "./glass/glass.css";

export interface LiquidGlassSurfaceProps {
  children: ReactNode;
  className?: string;
  intensity?: "subtle" | "strong";
  interactive?: boolean;
  finish?: "rounded" | "flat";
}

export function LiquidGlassSurface({ children, className, intensity = "subtle", interactive = true, finish = "rounded" }: LiquidGlassSurfaceProps) {
  const { surfaceRef, gpuHostRef, state } = useGlassSurface(interactive, intensity, finish === "rounded");
  const id = `glass-${useId().replace(/[^a-zA-Z0-9_-]/g, "")}`;
  return (
    <div ref={surfaceRef} className={`liquid-glass-surface liquid-glass-surface--${intensity}${className ? ` ${className}` : ""}`}
      data-glass-finish={finish} data-glass-state={state.mode} data-glass-reason={state.reason}>
      {/* Only this empty decorative layer filters the real DOM backdrop. */}
      <span className="liquid-glass-backdrop" aria-hidden="true" />
      {finish === "rounded" && <svg className="liquid-glass-svg" aria-hidden="true" focusable="false" width="100%" height="100%">
        <defs>
          <linearGradient id={`${id}-light`} x1="0" y1="0" x2="0.75" y2="1">
            <stop offset="0" stopColor="white" stopOpacity="0.82" />
            <stop offset="0.42" stopColor="white" stopOpacity="0.13" />
            <stop offset="0.7" stopColor="#d7e6ec" stopOpacity="0.08" />
            <stop offset="1" stopColor="white" stopOpacity="0.45" />
          </linearGradient>
          <linearGradient id={`${id}-shoulder-light`} x1="0" y1="0" x2="0.3" y2="1">
            <stop offset="0" stopColor="white" stopOpacity="0.3" />
            <stop offset="0.3" stopColor="white" stopOpacity="0.07" />
            <stop offset="0.62" stopColor="#293944" stopOpacity="0.08" />
            <stop offset="1" stopColor="#e6f1f5" stopOpacity="0.18" />
          </linearGradient>
          <mask id={`${id}-shoulder-mask`} maskContentUnits="userSpaceOnUse">
            <rect className="liquid-glass-mask-outer" width="100%" height="100%" fill="white" />
            <rect className="liquid-glass-shoulder-inner" fill="black" />
          </mask>
          <filter id={`${id}-edge`} x="-5%" y="-5%" width="110%" height="110%" colorInterpolationFilters="sRGB">
            <feTurbulence type="fractalNoise" baseFrequency="0.015 0.035" numOctaves="1" seed="7" result="edge-noise" />
            <feDisplacementMap in="SourceGraphic" in2="edge-noise" scale="0.45" xChannelSelector="R" yChannelSelector="G" />
          </filter>
          <mask id={`${id}-mask`} maskContentUnits="userSpaceOnUse">
            <rect className="liquid-glass-mask-outer" width="100%" height="100%" fill="white" />
            <rect className="liquid-glass-mask-inner" x="1.5" y="1.5" fill="black" />
          </mask>
        </defs>
        {/* Static shoulder survives reduced-motion, context-budget and GPU failures. */}
        <rect data-glass-shoulder="" width="100%" height="100%" fill={`url(#${id}-shoulder-light)`}
          mask={`url(#${id}-shoulder-mask)`} />
        <rect data-glass-rim="" width="100%" height="100%" fill={`url(#${id}-light)`}
          filter={`url(#${id}-edge)`} mask={`url(#${id}-mask)`} />
      </svg>}
      <span ref={gpuHostRef} className="liquid-glass-gpu-host" aria-hidden="true" />
      {/* display:contents preserves the caller's flex/grid children and gap. */}
      <div className="liquid-glass-content" style={{ display: "contents" }}>{children}</div>
    </div>
  );
}
