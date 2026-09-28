export interface GlassPointer {
  x: number;
  y: number;
}

export interface GlassSize {
  width: number;
  height: number;
  dpr: number;
  radius: number;
}

export interface GlassFrame {
  pointer: GlassPointer;
  intensity: number;
  dark: boolean;
}

export type RendererFailure =
  | "webgl-unavailable"
  | "resource-allocation"
  | "shader-compile"
  | "program-link"
  | "draw-failed";
export type RendererStatus = "ready" | "context-lost" | RendererFailure;

export interface RendererOptions {
  onStatusChange?: (status: RendererStatus) => void;
}

export interface GlassRenderer {
  resize(size: GlassSize): void;
  draw(frame: GlassFrame): void;
  /** True only when this context can no longer become live again. */
  dispose(): boolean;
}

export type RendererResult =
  | { ok: true; renderer: GlassRenderer }
  | { ok: false; reason: RendererFailure; contextReleased: boolean };

export type GlassFallbackReason = RendererFailure
  | "static"
  | "offscreen"
  | "hidden"
  | "budget"
  | "reduced-motion"
  | "reduced-transparency"
  | "high-contrast"
  | "context-lost"
  | "load-error";

export type GlassSurfaceState =
  | { mode: "gpu" | "loading"; reason?: undefined }
  | { mode: "fallback"; reason: GlassFallbackReason };
