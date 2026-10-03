/**
 * WebGL2 "liquid" surface for the new-session workspace hill.
 *
 * Deliberately separate from `components/ui/glass/renderer.ts`: that renderer decorates a
 * DOM edge and keeps its centre clear, while this one paints an opaque, self-animated
 * gradient inside a clipped arch. Both share the same conservative buffer budget.
 */

export type HillTriplet = [number, number, number];

export interface HillColors {
  a: HillTriplet;
  b: HillTriplet;
}

export interface HillRenderer {
  /** Draws one frame with the current hover/pointer state. Never starts a loop. */
  render(timeMs: number): void;
  /** 0 = idle, 1 = fully stirred. */
  setHover(value: number): void;
  /** Pointer position in 0..1 canvas space, y grown downwards. */
  setPointer(x: number, y: number): void;
  /** Re-applies theme colours after a light/dark switch. */
  setColors(colors: HillColors): void;
  dispose(): void;
}

const MAX_DPR = 1.5;
const MAX_PIXELS = 120_000;

const vertexSource = `#version 300 es
in vec2 aPosition;
void main() { gl_Position = vec4(aPosition, 0.0, 1.0); }
`;

const fragmentSource = `#version 300 es
precision mediump float;
uniform vec2 uResolution;
uniform vec2 uPointer;
uniform float uTime;
uniform float uHover;
uniform vec3 uColorA;
uniform vec3 uColorB;
out vec4 outColor;

float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

float valueNoise(vec2 p) {
  vec2 cell = floor(p);
  vec2 local = fract(p);
  vec2 eased = local * local * (3.0 - 2.0 * local);
  float a = hash(cell);
  float b = hash(cell + vec2(1.0, 0.0));
  float c = hash(cell + vec2(0.0, 1.0));
  float d = hash(cell + vec2(1.0, 1.0));
  return mix(mix(a, b, eased.x), mix(c, d, eased.x), eased.y);
}

float fbm(vec2 p) {
  float total = 0.0;
  float amplitude = 0.5;
  for (int i = 0; i < 3; i++) {
    total += valueNoise(p) * amplitude;
    p = p * 2.02 + 17.3;
    amplitude *= 0.5;
  }
  return total;
}

void main() {
  vec2 uv = gl_FragCoord.xy / uResolution;
  // Awake only while hovered: the idle frame stays a calm, almost still gradient.
  float stir = mix(0.16, 1.0, uHover);
  float speed = mix(0.02, 0.42, uHover);
  float t = uTime * speed;

  // Anthropomorphic hill proportions need horizontal stretching of the flow field.
  vec2 grid = vec2(uv.x * 0.8, uv.y * 2.6) + vec2(0.0, 1.4);

  vec2 warp = vec2(
    fbm(grid * 1.6 + vec2(t, -t * 0.55)),
    fbm(grid * 1.6 + vec2(3.1 - t * 0.8, 5.7 + t))
  ) - 0.5;

  // The pointer is the ripple centre: nearby flow bends away from it.
  vec2 toPointer = uv - uPointer;
  float falloff = 1.0 / (0.2 + dot(toPointer, toPointer) * 5.5);
  warp += toPointer * (0.4 * uHover * falloff);

  float bands = fbm(grid + warp * (0.85 * stir + 0.22) + vec2(t * 0.7, -t * 0.3));
  float band = sin((bands * 2.7 + uv.y * 0.4 + uv.x * 0.18) * 6.2831853);
  float blended = smoothstep(-0.9, 0.9, band);

  // Narrow the band range: the branch label has to stay legible over every band.
  vec3 color = mix(uColorA, mix(uColorA, uColorB, 0.72), blended);
  // Shaded base, lit crest: the shape must still read as a solid mound, not a wash.
  color *= mix(0.76, 1.08, smoothstep(-0.08, 0.98, uv.y));
  float crest = pow(max(1.0 - abs(uv.x - 0.5) * 2.0, 0.0), 1.7);
  color += crest * uv.y * uv.y * 0.07 * stir;
  float sheen = pow(max(1.0 - abs(uv.x - fract(t * 0.16)) * 3.4, 0.0), 3.0);
  color += sheen * 0.07 * stir;
  outColor = vec4(clamp(color, 0.0, 1.0), 1.0);
}
`;

function compile(
  gl: WebGL2RenderingContext,
  type: number,
  source: string,
): WebGLShader | null {
  const shader = gl.createShader(type);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
    gl.deleteShader(shader);
    return null;
  }
  return shader;
}

/** Returns null when WebGL2 is unavailable, which callers render as the CSS fallback. */
export function createHillRenderer(
  canvas: HTMLCanvasElement,
  colors: HillColors,
): HillRenderer | null {
  let gl: WebGL2RenderingContext | null;
  try {
    gl = canvas.getContext("webgl2", {
      alpha: false,
      antialias: false,
      depth: false,
      stencil: false,
      premultipliedAlpha: false,
      powerPreference: "low-power",
    });
  } catch {
    gl = null;
  }
  if (!gl) return null;
  const context = gl;

  const vertex = compile(context, context.VERTEX_SHADER, vertexSource);
  const fragment = compile(context, context.FRAGMENT_SHADER, fragmentSource);
  if (!vertex || !fragment) {
    if (vertex) context.deleteShader(vertex);
    if (fragment) context.deleteShader(fragment);
    return null;
  }
  const program = context.createProgram();
  if (!program) {
    context.deleteShader(vertex);
    context.deleteShader(fragment);
    return null;
  }
  context.attachShader(program, vertex);
  context.attachShader(program, fragment);
  context.linkProgram(program);
  if (!context.getProgramParameter(program, context.LINK_STATUS)) {
    context.deleteProgram(program);
    context.deleteShader(vertex);
    context.deleteShader(fragment);
    return null;
  }
  context.deleteShader(vertex);
  context.deleteShader(fragment);

  const buffer = context.createBuffer();
  const position = context.getAttribLocation(program, "aPosition");
  if (!buffer || position < 0) {
    context.deleteProgram(program);
    if (buffer) context.deleteBuffer(buffer);
    return null;
  }
  context.useProgram(program);
  context.bindBuffer(context.ARRAY_BUFFER, buffer);
  // One oversized triangle covers the clip space cheaper than a quad.
  context.bufferData(
    context.ARRAY_BUFFER,
    new Float32Array([-1, -1, 3, -1, -1, 3]),
    context.STATIC_DRAW,
  );
  context.enableVertexAttribArray(position);
  context.vertexAttribPointer(position, 2, context.FLOAT, false, 0, 0);

  const resolution = context.getUniformLocation(program, "uResolution");
  const pointer = context.getUniformLocation(program, "uPointer");
  const time = context.getUniformLocation(program, "uTime");
  const hover = context.getUniformLocation(program, "uHover");
  const colorA = context.getUniformLocation(program, "uColorA");
  const colorB = context.getUniformLocation(program, "uColorB");

  let hoverValue = 0;
  let pointerValue: [number, number] = [0.5, 0.6];
  let current = colors;
  let disposed = false;

  const applyColors = () => {
    context.uniform3f(colorA, current.a[0], current.a[1], current.a[2]);
    context.uniform3f(colorB, current.b[0], current.b[1], current.b[2]);
  };
  applyColors();

  const fit = () => {
    const cssWidth = Math.max(1, canvas.clientWidth || canvas.width || 1);
    const cssHeight = Math.max(1, canvas.clientHeight || canvas.height || 1);
    const dpr = Math.min(
      typeof window === "undefined" ? 1 : window.devicePixelRatio || 1,
      MAX_DPR,
      Math.sqrt(MAX_PIXELS / (cssWidth * cssHeight)),
    );
    const width = Math.max(1, Math.round(cssWidth * dpr));
    const height = Math.max(1, Math.round(cssHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
    context.viewport(0, 0, canvas.width, canvas.height);
    return { width: canvas.width, height: canvas.height };
  };

  return {
    render(timeMs: number) {
      if (disposed) return;
      const size = fit();
      context.useProgram(program);
      context.uniform2f(resolution, size.width, size.height);
      // Uniform pointer space grows upwards in GL, downwards in the DOM.
      context.uniform2f(pointer, pointerValue[0], 1 - pointerValue[1]);
      context.uniform1f(time, Math.max(0, timeMs) / 1000);
      context.uniform1f(hover, hoverValue);
      applyColors();
      context.drawArrays(context.TRIANGLES, 0, 3);
    },
    setHover(value: number) {
      hoverValue = Math.min(1, Math.max(0, value));
    },
    setPointer(x: number, y: number) {
      pointerValue = [
        Math.min(1, Math.max(0, x)),
        Math.min(1, Math.max(0, y)),
      ];
    },
    setColors(next: HillColors) {
      current = next;
      applyColors();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      context.deleteBuffer(buffer);
      context.deleteProgram(program);
    },
  };
}
