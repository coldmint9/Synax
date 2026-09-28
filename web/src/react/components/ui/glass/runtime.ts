import { createGlassScheduler, type GlassScheduler } from "./scheduler";
import type { createGlassRenderer } from "./renderer";

export interface GlassRuntime {
  scheduler: GlassScheduler;
  loadRenderer(): Promise<{ createGlassRenderer: typeof createGlassRenderer }>;
}

const runtime: GlassRuntime = {
  scheduler: createGlassScheduler(),
  // The shader/compiler is not part of Button's or the static surface's eager bundle.
  loadRenderer: () => import("./renderer"),
};

/** Injection seam for lifecycle tests; production surfaces share this one scheduler. */
export function getGlassRuntime(): GlassRuntime { return runtime; }
