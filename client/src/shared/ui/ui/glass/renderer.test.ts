import { afterEach, describe, expect, it, vi } from "vitest";
import { createGlassRenderer, getDrawingBufferSize } from "./renderer";
import { createMockGL } from "./__tests__/helpers";

function fixture() {
  const mock = createMockGL();
  const canvas = document.createElement("canvas");
  vi.spyOn(canvas, "getContext").mockReturnValue(mock.context);
  const status = vi.fn();
  return { ...mock, canvas, status, create: () => createGlassRenderer(canvas, { onStatusChange: status }) };
}

afterEach(() => vi.restoreAllMocks());

describe("glass drawing budgets", () => {
  it("clamps DPR and proportionally downsamples large surfaces", () => {
    expect(getDrawingBufferSize(100, 50, 3)).toEqual({ width: 150, height: 75 });
    const size = getDrawingBufferSize(3000, 2000, 2);
    expect(size.width * size.height).toBeLessThanOrEqual(512_000);
    expect(size.width / size.height).toBeCloseTo(1.5, 2);
  });
  it("keeps degenerate, extreme and nonfinite sizes bounded", () => {
    for (const [w, h, dpr] of [[0, 0, 0], [Infinity, NaN, Infinity], [1e12, 1, 4], [1, 1e12, 2], [-20, 10, -1]]) {
      const size = getDrawingBufferSize(w, h, dpr);
      expect(size.width).toBeGreaterThanOrEqual(1);
      expect(size.height).toBeGreaterThanOrEqual(1);
      expect(size.width * size.height).toBeLessThanOrEqual(512_000);
      expect(Number.isFinite(size.width + size.height)).toBe(true);
    }
  });
});

describe("WebGL2 renderer lifecycle", () => {
  it("returns explicit fallback when WebGL is unavailable or throws", () => {
    const canvas = document.createElement("canvas");
    const getContext = vi.spyOn(canvas, "getContext").mockReturnValue(null);
    expect(createGlassRenderer(canvas)).toMatchObject({ ok: false, reason: "webgl-unavailable", contextReleased: true });
    getContext.mockImplementation(() => { throw new Error("disabled"); });
    expect(createGlassRenderer(canvas)).toMatchObject({ ok: false, reason: "webgl-unavailable", contextReleased: true });
  });

  it.each(["compile", "link", "buffer", "program", "shader", "uniform", "attribute"] as const)("cleans partially created resources on %s failure", (failure) => {
    const f = fixture();
    if (failure === "compile") f.gl.getShaderParameter.mockReturnValue(false);
    if (failure === "link") f.gl.getProgramParameter.mockReturnValue(false);
    if (failure === "buffer") f.gl.createBuffer.mockReturnValue(null as never);
    if (failure === "program") f.gl.createProgram.mockReturnValue(null as never);
    if (failure === "shader") f.gl.createShader.mockReturnValue(null as never);
    if (failure === "uniform") f.gl.getUniformLocation.mockReturnValue(null as never);
    if (failure === "attribute") f.gl.getAttribLocation.mockReturnValue(-1);
    expect(f.create()).toMatchObject({ ok: false });
    for (const [create, remove] of [[f.gl.createShader, f.gl.deleteShader], [f.gl.createProgram, f.gl.deleteProgram], [f.gl.createBuffer, f.gl.deleteBuffer]]) {
      const created = create.mock.results.filter((result) => result.type === "return" && result.value !== null);
      expect(remove).toHaveBeenCalledTimes(created.length);
    }
    expect(f.loseContext).toHaveBeenCalledOnce();
    f.canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(f.status).not.toHaveBeenCalled();
  });

  it("uploads latest pointer and size uniforms without recompiling on resize; disposes once", () => {
    const f = fixture();
    const result = f.create();
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.reason);
    result.renderer.resize({ width: 320, height: 48, dpr: 2, radius: 24 });
    result.renderer.draw({ pointer: { x: 0.2, y: 0.3 }, intensity: 0.6, dark: false });
    result.renderer.draw({ pointer: { x: 0.9, y: 0.8 }, intensity: 0.6, dark: true });
    expect(f.gl.uniform2f).toHaveBeenCalledWith({ name: "uPointer" }, 0.9, expect.closeTo(0.2));
    result.renderer.resize({ width: 4000, height: 1000, dpr: 4, radius: 24 });
    result.renderer.draw({ pointer: { x: 0.5, y: 0.5 }, intensity: 1, dark: false });
    expect(f.canvas.width * f.canvas.height).toBeLessThanOrEqual(512_000);
    expect(f.gl.uniform2f).toHaveBeenCalledWith({ name: "uSize" }, 4000, 1000);
    expect(f.gl.uniform2f).toHaveBeenCalledWith({ name: "uResolution" }, f.canvas.width, f.canvas.height);
    expect(f.gl.compileShader).toHaveBeenCalledTimes(2);
    result.renderer.dispose(); result.renderer.dispose();
    expect(f.gl.deleteShader).toHaveBeenCalledTimes(2);
    expect(f.gl.deleteProgram).toHaveBeenCalledOnce();
    expect(f.gl.deleteBuffer).toHaveBeenCalledOnce();
    expect(f.loseContext).toHaveBeenCalledOnce();
    const draws = f.gl.drawArrays.mock.calls.length;
    result.renderer.draw({ pointer: { x: 0, y: 0 }, intensity: 1, dark: false });
    expect(f.gl.drawArrays).toHaveBeenCalledTimes(draws);
    f.canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(f.status).not.toHaveBeenCalled();
  });

  it("stops on loss, rebuilds on restoration, then draws with the retained size", () => {
    const f = fixture();
    const result = f.create();
    if (!result.ok) throw new Error(result.reason);
    result.renderer.resize({ width: 300, height: 50, dpr: 1.5, radius: 25 });
    const lost = new Event("webglcontextlost", { cancelable: true });
    f.canvas.dispatchEvent(lost);
    expect(lost.defaultPrevented).toBe(true);
    expect(f.status).toHaveBeenLastCalledWith("context-lost");
    result.renderer.draw({ pointer: { x: 0, y: 0 }, intensity: 1, dark: false });
    expect(f.gl.drawArrays).not.toHaveBeenCalled();
    f.canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(f.status).toHaveBeenLastCalledWith("ready");
    expect(f.gl.compileShader).toHaveBeenCalledTimes(4);
    result.renderer.draw({ pointer: { x: 0, y: 0 }, intensity: 1, dark: false });
    expect(f.gl.uniform2f).toHaveBeenCalledWith({ name: "uSize" }, 300, 50);
    result.renderer.dispose();
    expect(f.gl.deleteProgram).toHaveBeenCalledTimes(2);
    expect(f.gl.deleteBuffer).toHaveBeenCalledTimes(2);
  });

  it("reports restoration failure without retrying itself", () => {
    const f = fixture();
    const result = f.create();
    if (!result.ok) throw new Error(result.reason);
    f.canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    f.gl.getProgramParameter.mockReturnValue(false);
    f.canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(f.status).toHaveBeenLastCalledWith("program-link");
    expect(f.gl.linkProgram).toHaveBeenCalledTimes(2);
    result.renderer.dispose();
  });

  it("confirms physical context release and preserves that result on repeated disposal", () => {
    const f = fixture();
    const result = f.create();
    if (!result.ok) throw new Error(result.reason);
    expect(result.renderer.dispose()).toBe(true);
    expect(f.gl.isContextLost()).toBe(true);
    expect(result.renderer.dispose()).toBe(true);
    expect(f.loseContext).toHaveBeenCalledOnce();
  });

  it.each(["missing", "lookup-throws", "lose-throws", "not-lost"] as const)("reports unreleased contexts when release is %s", (mode) => {
    const f = fixture();
    if (mode === "missing") f.gl.getExtension.mockReturnValue(null);
    if (mode === "lookup-throws") f.gl.getExtension.mockImplementation(() => { throw new Error("extension unavailable"); });
    if (mode === "lose-throws") f.loseContext.mockImplementation(() => { throw new Error("driver refused release"); });
    if (mode === "not-lost") f.loseContext.mockImplementation(() => {});
    const result = f.create();
    if (!result.ok) throw new Error(result.reason);
    expect(result.renderer.dispose()).toBe(false);
    expect(result.renderer.dispose()).toBe(false);
    expect(f.gl.isContextLost()).toBe(false);
    expect(f.gl.deleteShader).toHaveBeenCalledTimes(2);
    expect(f.gl.deleteProgram).toHaveBeenCalledOnce();
    expect(f.gl.deleteBuffer).toHaveBeenCalledOnce();
  });

  it.each(["shader-compile", "program-link"] as const)("retains the failed-construction reservation after %s without a loss extension", (reason) => {
    const f = fixture();
    f.gl.getExtension.mockReturnValue(null);
    if (reason === "shader-compile") f.gl.getShaderParameter.mockReturnValue(false);
    else f.gl.getProgramParameter.mockReturnValue(false);
    expect(f.create()).toEqual({ ok: false, reason, contextReleased: false });
    expect(f.gl.isContextLost()).toBe(false);
  });

  it("does not treat a naturally lost context awaiting automatic restoration as permanently released", () => {
    const f = fixture();
    const result = f.create();
    if (!result.ok) throw new Error(result.reason);
    f.gl.isContextLost.mockReturnValue(true);
    f.canvas.dispatchEvent(new Event("webglcontextlost", { cancelable: true }));
    expect(result.renderer.dispose()).toBe(false);
    expect(f.loseContext).not.toHaveBeenCalled();
    // The browser can still restore a context whose loss event was canceled.
    f.gl.isContextLost.mockReturnValue(false);
    f.canvas.dispatchEvent(new Event("webglcontextrestored"));
    expect(result.renderer.dispose()).toBe(false);
    expect(f.gl.compileShader).toHaveBeenCalledTimes(2);
    expect(f.status).toHaveBeenCalledExactlyOnceWith("context-lost");
  });

});
