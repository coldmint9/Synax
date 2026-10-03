import { vi } from "vitest";
import type { FrameClock } from "../scheduler";

export function createFrameClock() {
  let now = 0;
  let id = 0;
  const frames = new Map<number, FrameRequestCallback>();
  return {
    now: () => now,
    request: (callback: FrameRequestCallback) => { frames.set(++id, callback); return id; },
    cancel: (handle: number) => { frames.delete(handle); },
    pending: () => frames.size,
    flush: (time: number) => {
      now = time;
      const callbacks = [...frames.values()];
      frames.clear();
      for (const callback of callbacks) callback(time);
    },
  } satisfies FrameClock & { pending(): number; flush(time: number): void };
}

/** Only the WebGL entry points used by the renderer; tests never need a GPU. */
export function createMockGL() {
  let id = 0;
  const resource = () => ({ id: ++id });
  let contextLost = false;
  const loseContext = vi.fn(() => { contextLost = true; });
  const gl = {
    VERTEX_SHADER: 35633, FRAGMENT_SHADER: 35632, COMPILE_STATUS: 35713, LINK_STATUS: 35714,
    ARRAY_BUFFER: 34962, STATIC_DRAW: 35044, FLOAT: 5126, TRIANGLES: 4, COLOR_BUFFER_BIT: 16384,
    createShader: vi.fn(resource), shaderSource: vi.fn(), compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true), deleteShader: vi.fn(), getShaderInfoLog: vi.fn(() => "bad shader"),
    createProgram: vi.fn(resource), attachShader: vi.fn(), detachShader: vi.fn(), linkProgram: vi.fn(),
    getProgramParameter: vi.fn(() => true), getProgramInfoLog: vi.fn(() => "bad program"), deleteProgram: vi.fn(),
    createBuffer: vi.fn(resource), bindBuffer: vi.fn(), bufferData: vi.fn(), deleteBuffer: vi.fn(),
    getAttribLocation: vi.fn(() => 0), enableVertexAttribArray: vi.fn(), vertexAttribPointer: vi.fn(),
    getUniformLocation: vi.fn((_program: unknown, name: string) => ({ name })),
    viewport: vi.fn(), clearColor: vi.fn(), clear: vi.fn(), useProgram: vi.fn(),
    uniform1f: vi.fn(), uniform2f: vi.fn(), drawArrays: vi.fn(), isContextLost: vi.fn(() => contextLost),
    getExtension: vi.fn((name: string) => name === "WEBGL_lose_context" ? { loseContext } : null),
  };
  return { gl, context: gl as unknown as WebGL2RenderingContext, loseContext };
}
