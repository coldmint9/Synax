import { useEffect, useId, useRef, useState, type CSSProperties, type ReactNode } from "react";

interface LiquidGlassSurfaceProps {
  children: ReactNode;
  className?: string;
  intensity?: "subtle" | "strong";
  interactive?: boolean;
}

function drawShader(canvas: HTMLCanvasElement, pointer: { x: number; y: number }) {
  const gl = canvas.getContext("webgl2", { alpha: true, antialias: true, premultipliedAlpha: true });
  if (!gl) return () => {};
  const vertex = `#version 300 es
    in vec2 position;
    void main() { gl_Position = vec4(position, 0.0, 1.0); }
  `;
  const fragment = `#version 300 es
    precision highp float;
    uniform float uTime;
    uniform vec2 uPointer;
    out vec4 color;
    void main() {
      vec2 uv = gl_FragCoord.xy / vec2(${Math.max(canvas.width, 1)}.0, ${Math.max(canvas.height, 1)}.0);
      float edge = smoothstep(0.02, 0.28, uv.x) * smoothstep(0.02, 0.28, 1.0 - uv.x) * smoothstep(0.02, 0.28, uv.y) * smoothstep(0.02, 0.28, 1.0 - uv.y);
      float wave = sin((uv.x + uTime * .035) * 8.0) * .5 + sin((uv.y - uTime * .025) * 7.0) * .5;
      float focus = exp(-distance(uv, uPointer) * 5.2);
      vec3 cool = vec3(.27, .60, 1.0);
      vec3 warm = vec3(.94, .55, .98);
      vec3 tint = mix(cool, warm, smoothstep(-1.0, 1.0, wave + focus * .45));
      float alpha = (.035 + edge * .045 + focus * .06) * (0.72 + 0.28 * sin(uTime * .4));
      color = vec4(tint, alpha);
    }
  `;
  const compile = (type: number, source: string) => { const shader = gl.createShader(type)!; gl.shaderSource(shader, source); gl.compileShader(shader); return shader; };
  const program = gl.createProgram()!;
  gl.attachShader(program, compile(gl.VERTEX_SHADER, vertex));
  gl.attachShader(program, compile(gl.FRAGMENT_SHADER, fragment));
  gl.linkProgram(program);
  const buffer = gl.createBuffer(); gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const position = gl.getAttribLocation(program, "position");
  gl.enableVertexAttribArray(position); gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
  const time = gl.getUniformLocation(program, "uTime");
  const pointerLocation = gl.getUniformLocation(program, "uPointer");
  const start = performance.now();
  let raf = 0;
  const frame = (now: number) => {
    gl.viewport(0, 0, canvas.width, canvas.height);
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(program); gl.uniform1f(time, (now - start) / 1000); gl.uniform2f(pointerLocation, pointer.x, 1 - pointer.y);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return () => { cancelAnimationFrame(raf); gl.deleteProgram(program); if (buffer) gl.deleteBuffer(buffer); };
}

export function LiquidGlassSurface({ children, className, intensity = "subtle", interactive = true }: LiquidGlassSurfaceProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pointer = useRef({ x: 0.5, y: 0.5 });
  const id = useId();
  const filterId = `liquid-glass-${id.replace(/:/g, "")}`;
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cleanup = () => {};
    const resize = () => {
      const rect = canvas.getBoundingClientRect();
      const scale = Math.min(window.devicePixelRatio || 1, 1.5);
      canvas.width = Math.max(1, Math.floor(rect.width * scale));
      canvas.height = Math.max(1, Math.floor(rect.height * scale));
      cleanup(); cleanup = drawShader(canvas, pointer.current);
    };
    resize();
    window.addEventListener("resize", resize);
    return () => { window.removeEventListener("resize", resize); cleanup(); };
  }, []);
  const style = { "--liquid-filter": `url(#${filterId})` } as CSSProperties;
  return <div className={`liquid-glass-surface liquid-glass-surface--${intensity} ${className ?? ""}`} style={style}
    onPointerMove={interactive ? (event) => { const rect = event.currentTarget.getBoundingClientRect(); pointer.current = { x: (event.clientX - rect.left) / rect.width, y: (event.clientY - rect.top) / rect.height }; } : undefined}>
    <svg className="liquid-glass-svg" aria-hidden="true"><defs><filter id={filterId} x="-20%" y="-20%" width="140%" height="140%"><feTurbulence type="fractalNoise" baseFrequency="0.018 0.032" numOctaves="2" seed="7" result="noise" /><feDisplacementMap in="SourceGraphic" in2="noise" scale="7" xChannelSelector="R" yChannelSelector="G" /></filter></defs></svg>
    <canvas ref={canvasRef} className="liquid-glass-canvas" aria-hidden="true" />
    <span className="liquid-glass-rim" aria-hidden="true" />
    <div className="liquid-glass-content">{children}</div>
  </div>;
}
