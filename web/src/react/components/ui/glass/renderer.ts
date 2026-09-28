import type { GlassFrame, GlassRenderer, GlassSize, RendererFailure, RendererOptions, RendererResult } from "./types";

export const MAX_DPR = 1.5;
export const MAX_SURFACE_PIXELS = 512_000;
// Also avoid oversized single axes on very long, thin surfaces.
const MAX_BUFFER_AXIS = 4096;

const positive = (value: number, fallback = 1) => Number.isFinite(value) && value > 0 ? value : fallback;

export function getDrawingBufferSize(width: number, height: number, dpr: number) {
  const w = positive(width);
  const h = positive(height);
  const scale = Math.min(positive(dpr), MAX_DPR, Math.sqrt(MAX_SURFACE_PIXELS / w / h), MAX_BUFFER_AXIS / w, MAX_BUFFER_AXIS / h);
  return { width: Math.max(1, Math.floor(w * scale)), height: Math.max(1, Math.floor(h * scale)) };
}

const vertexSource = `#version 300 es
in vec2 aPosition;
void main() { gl_Position = vec4(aPosition, 0.0, 1.0); }
`;

// Procedural optical edge decoration, NOT a DOM/backdrop refraction texture.
// CSS owns real backdrop blur; the center of this premultiplied canvas is clear.
const fragmentSource = `#version 300 es
precision highp float;
uniform vec2 uResolution;
uniform vec2 uSize;
uniform vec2 uPointer;
uniform float uRadius;
uniform float uIntensity;
uniform float uDark;
out vec4 color;
void main() {
  vec2 p = (gl_FragCoord.xy / uResolution - 0.5) * uSize;
  vec2 halfSize = uSize * 0.5;
  float radius = clamp(uRadius, 0.0, min(halfSize.x, halfSize.y));
  vec2 q = abs(p) - (halfSize - vec2(radius));
  vec2 outside = max(q, 0.0);
  float distanceToEdge = length(outside) + min(max(q.x, q.y), 0.0) - radius;
  vec2 normal = length(outside) > 0.0001
    ? normalize(outside) * sign(p)
    : (q.x > q.y ? vec2(sign(p.x), 0.0) : vec2(0.0, sign(p.y)));
  // A quarter-round bevel turns from a steep lip into the flat, clear face.
  // Work in CSS pixels so compact controls and HiDPI islands share the profile.
  float bevelWidth = min(8.0, min(uSize.x, uSize.y) * 0.16);
  float inset = max(-distanceToEdge, 0.0);
  float bevelPosition = clamp(inset / max(bevelWidth, 0.001), 0.0, 1.0);
  float slope = 1.0 - bevelPosition;
  vec3 bevelNormal = vec3(normal * slope, sqrt(max(1.0 - slope * slope, 0.0)));
  vec2 light = normalize(vec2(-0.45, 0.85) + (uPointer - 0.5) * 0.65);
  float facing = dot(normal, light);
  vec3 halfLight = normalize(vec3(light * 0.8, 1.0));
  float softReflection = pow(max(dot(bevelNormal, halfLight), 0.0), 10.0);
  float specular = pow(max(facing, 0.0), 3.0);
  float opposite = pow(max(-facing, 0.0), 4.0);
  float fresnel = pow(1.0 - bevelNormal.z, 3.0);
  float fineRim = exp(-pow((inset - 0.85) / 0.7, 2.0));
  float shoulder = exp(-pow((bevelPosition - 0.38) / 0.3, 2.0));
  float innerReturn = exp(-pow((bevelPosition - 0.78) / 0.13, 2.0));
  // Explicitly end the optical band: no haze/tint over the center or text.
  float edgeBand = 1.0 - smoothstep(0.8, 1.0, bevelPosition);
  float coverage = 1.0 - smoothstep(-max(fwidth(distanceToEdge), 0.55), 0.0, distanceToEdge);
  float reflection = fineRim * (0.14 + specular * 0.48 + opposite * 0.14)
    + shoulder * (0.035 + softReflection * 0.25)
    + innerReturn * opposite * 0.09 + fresnel * 0.08;
  // A shaded inner shoulder gives the bright lip depth on light backgrounds.
  float shade = shoulder * (1.0 - softReflection) * mix(0.07, 0.025, uDark);
  float dispersion = normal.x * normal.y * fineRim * 0.025;
  vec3 tint = vec3(0.97 + dispersion, 0.985, 1.0 - dispersion);
  float strength = edgeBand * coverage * uIntensity * mix(0.88, 1.0, uDark);
  float alpha = clamp((reflection + shade) * strength, 0.0, 1.0);
  vec3 reflectedColor = (tint * reflection + vec3(0.16, 0.21, 0.25) * shade)
    / max(reflection + shade, 0.0001);
  color = vec4(clamp(reflectedColor, 0.0, 1.0) * alpha, alpha);
}
`;

class InitializationFailure extends Error {
  constructor(readonly reason: RendererFailure) { super(reason); }
}

interface Resources {
  program: WebGLProgram;
  buffer: WebGLBuffer;
  position: number;
  uniforms: Record<"uResolution" | "uSize" | "uPointer" | "uRadius" | "uIntensity" | "uDark", WebGLUniformLocation>;
}

function buildResources(gl: WebGL2RenderingContext): Resources {
  const shaders: WebGLShader[] = [];
  let program: WebGLProgram | null = null;
  let buffer: WebGLBuffer | null = null;
  let complete = false;
  try {
    const compile = (type: number, source: string) => {
      const shader = gl.createShader(type);
      if (!shader) throw new InitializationFailure("resource-allocation");
      shaders.push(shader);
      gl.shaderSource(shader, source);
      gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new InitializationFailure("shader-compile");
      return shader;
    };
    const vertex = compile(gl.VERTEX_SHADER, vertexSource);
    const fragment = compile(gl.FRAGMENT_SHADER, fragmentSource);
    program = gl.createProgram();
    if (!program) throw new InitializationFailure("resource-allocation");
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new InitializationFailure("program-link");
    buffer = gl.createBuffer();
    if (!buffer) throw new InitializationFailure("resource-allocation");
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    // A single oversized triangle avoids a diagonal seam in the optical rim.
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const position = gl.getAttribLocation(program, "aPosition");
    if (position < 0) throw new InitializationFailure("resource-allocation");
    const uniform = (name: string) => {
      const location = gl.getUniformLocation(program!, name);
      if (location === null) throw new InitializationFailure("resource-allocation");
      return location;
    };
    const uniforms = {
      uResolution: uniform("uResolution"), uSize: uniform("uSize"), uPointer: uniform("uPointer"),
      uRadius: uniform("uRadius"), uIntensity: uniform("uIntensity"), uDark: uniform("uDark"),
    };
    complete = true;
    return { program, buffer, position, uniforms };
  } finally {
    // Linked programs retain executable code; shader objects need not stay alive.
    for (const shader of shaders) {
      if (complete && program) gl.detachShader(program, shader);
      gl.deleteShader(shader);
    }
    if (!complete) {
      if (buffer) gl.deleteBuffer(buffer);
      if (program) gl.deleteProgram(program);
    }
  }
}

function releaseContext(gl: WebGL2RenderingContext): boolean {
  // Deleting objects does not release the context. A naturally lost context can
  // still restore after disposal because onLost opted in with preventDefault.
  // Only a fresh, confirmed intentional loss lets the scheduler recycle a slot.
  try {
    if (gl.isContextLost()) return false;
    const extension = gl.getExtension("WEBGL_lose_context");
    if (!extension) return false;
    extension.loseContext();
    return gl.isContextLost();
  } catch { return false; }
}

export function createGlassRenderer(canvas: HTMLCanvasElement, options: RendererOptions = {}): RendererResult {
  let gl: WebGL2RenderingContext | null;
  try {
    gl = canvas.getContext("webgl2", { alpha: true, antialias: false, premultipliedAlpha: true, depth: false, stencil: false, powerPreference: "low-power" });
  } catch { return { ok: false, reason: "webgl-unavailable", contextReleased: true }; }
  if (!gl) return { ok: false, reason: "webgl-unavailable", contextReleased: true };
  const context = gl;
  let resources: Resources | null = null;
  let disposed = false;
  let contextReleased = false;
  let lost = false;
  let size: GlassSize = { width: 1, height: 1, dpr: 1, radius: 0 };

  const clearResources = () => {
    if (!resources) return;
    context.deleteBuffer(resources.buffer);
    context.deleteProgram(resources.program);
    resources = null;
  };
  const initialize = (): RendererFailure | null => {
    try { resources = buildResources(context); return null; }
    catch (error) { return error instanceof InitializationFailure ? error.reason : "resource-allocation"; }
  };
  const failure = initialize();
  if (failure) return { ok: false, reason: failure, contextReleased: releaseContext(context) };

  const onLost = (event: Event) => {
    if (disposed) return;
    event.preventDefault(); // Opt in to browser-driven restoration, not a retry loop.
    lost = true;
    clearResources();
    options.onStatusChange?.("context-lost");
  };
  const onRestored = () => {
    if (disposed || !lost) return;
    lost = false;
    const failure = initialize();
    options.onStatusChange?.(failure ?? "ready");
  };
  canvas.addEventListener("webglcontextlost", onLost);
  canvas.addEventListener("webglcontextrestored", onRestored);

  const renderer: GlassRenderer = {
    resize(next) {
      if (disposed) return;
      size = { width: positive(next.width), height: positive(next.height), dpr: positive(next.dpr), radius: Math.max(0, Number.isFinite(next.radius) ? next.radius : 0) };
      const buffer = getDrawingBufferSize(size.width, size.height, size.dpr);
      if (canvas.width !== buffer.width) canvas.width = buffer.width;
      if (canvas.height !== buffer.height) canvas.height = buffer.height;
    },
    draw(frame: GlassFrame) {
      if (disposed || lost || !resources || context.isContextLost()) return;
      try {
        const { program, buffer, uniforms, position } = resources;
        context.viewport(0, 0, canvas.width, canvas.height);
        context.clearColor(0, 0, 0, 0);
        context.clear(context.COLOR_BUFFER_BIT);
        context.useProgram(program);
        context.bindBuffer(context.ARRAY_BUFFER, buffer);
        context.enableVertexAttribArray(position);
        context.vertexAttribPointer(position, 2, context.FLOAT, false, 0, 0);
        context.uniform2f(uniforms.uResolution, canvas.width, canvas.height);
        context.uniform2f(uniforms.uSize, size.width, size.height);
        context.uniform2f(uniforms.uPointer, frame.pointer.x, 1 - frame.pointer.y);
        context.uniform1f(uniforms.uRadius, size.radius);
        context.uniform1f(uniforms.uIntensity, frame.intensity);
        context.uniform1f(uniforms.uDark, Number(frame.dark));
        context.drawArrays(context.TRIANGLES, 0, 3);
      } catch {
        clearResources();
        options.onStatusChange?.("draw-failed");
      }
    },
    dispose() {
      if (disposed) return contextReleased;
      disposed = true;
      canvas.removeEventListener("webglcontextlost", onLost);
      canvas.removeEventListener("webglcontextrestored", onRestored);
      try { clearResources(); }
      finally { contextReleased = releaseContext(context); }
      return contextReleased;
    },
  };
  return { ok: true, renderer };
}
