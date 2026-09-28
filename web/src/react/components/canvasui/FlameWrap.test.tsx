import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FLAME_PURPLE,
  FlameWrap,
  createFlameWrap,
  flameOverlayInsets,
  supportsHtmlInCanvas,
} from "./FlameWrap";

/** Only the WebGL2 entry points the flame renderer touches; tests never need a GPU. */
function createMockGL() {
  let id = 0;
  const resource = () => ({ id: ++id });
  const uniformNames = ["uColor", "uEdgeFade"];
  return {
    VERTEX_SHADER: 35633,
    FRAGMENT_SHADER: 35632,
    COMPILE_STATUS: 35713,
    ACTIVE_UNIFORMS: 35718,
    ARRAY_BUFFER: 34962,
    STATIC_DRAW: 35044,
    FLOAT: 5126,
    TRIANGLE_STRIP: 5,
    TEXTURE_2D: 3553,
    TEXTURE_MIN_FILTER: 10241,
    TEXTURE_MAG_FILTER: 10240,
    TEXTURE_WRAP_S: 10242,
    TEXTURE_WRAP_T: 10243,
    LINEAR: 9729,
    CLAMP_TO_EDGE: 33071,
    RGBA: 6408,
    UNSIGNED_BYTE: 5121,
    FRAMEBUFFER: 36160,
    TEXTURE0: 33984,
    createShader: vi.fn(resource),
    shaderSource: vi.fn(),
    compileShader: vi.fn(),
    getShaderParameter: vi.fn(() => true),
    getShaderInfoLog: vi.fn(() => ""),
    createProgram: vi.fn(resource),
    attachShader: vi.fn(),
    linkProgram: vi.fn(),
    getProgramParameter: vi.fn((_program: unknown, pname: number) =>
      pname === 35718 ? uniformNames.length : true,
    ),
    getActiveUniform: vi.fn((_program: unknown, index: number) => ({
      name: uniformNames[index],
      size: 1,
      type: 0,
    })),
    getUniformLocation: vi.fn((_program: unknown, name: string) => ({ name })),
    createBuffer: vi.fn(resource),
    bindBuffer: vi.fn(),
    bufferData: vi.fn(),
    enableVertexAttribArray: vi.fn(),
    vertexAttribPointer: vi.fn(),
    createTexture: vi.fn(resource),
    bindTexture: vi.fn(),
    texParameteri: vi.fn(),
    texImage2D: vi.fn(),
    activeTexture: vi.fn(),
    uniform1i: vi.fn(),
    uniform1f: vi.fn(),
    uniform2f: vi.fn(),
    uniform3f: vi.fn(),
    useProgram: vi.fn(),
    viewport: vi.fn(),
    bindFramebuffer: vi.fn(),
    drawArrays: vi.fn(),
    deleteTexture: vi.fn(),
    deleteProgram: vi.fn(),
    deleteShader: vi.fn(),
    deleteBuffer: vi.fn(),
    isContextLost: vi.fn(() => false),
  };
}

type MockGL = ReturnType<typeof createMockGL>;

function elementFixture(gl: MockGL) {
  const source = document.createElement("canvas");
  const content = document.createElement("div");
  const output = document.createElement("canvas");
  vi.spyOn(source, "getContext").mockReturnValue(null);
  vi.spyOn(output, "getContext").mockReturnValue(
    gl as unknown as WebGL2RenderingContext,
  );
  document.body.append(source, output);
  return { source, content, output };
}

/** Reduced motion keeps the effect in one static frame, so tests stay deterministic. */
function freezeMotion() {
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: true,
      media: query,
      onchange: null,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  document.body.replaceChildren();
});

describe("FlameWrap", () => {
  it("keeps the default flame purple and matches the project electric purple", () => {
    expect(FLAME_PURPLE).toEqual([0.5745, 0.3124, 0.9676]);
  });

  it("reserves a horizontal budget so the fire never meets the canvas wall", () => {
    expect(flameOverlayInsets({ height: 170, spread: 8 })).toEqual({
      reach: 295,
      glow: 40,
      side: 118,
    });
    // Small effects keep the tight legacy margins.
    expect(flameOverlayInsets({ height: 24, spread: 8 })).toEqual({
      reach: 76,
      glow: 40,
      side: 40,
    });
  });

  it("renders content without a GPU overlay when html-in-canvas is unavailable", async () => {
    expect(supportsHtmlInCanvas()).toBe(false);
    const { container } = render(<FlameWrap>composer</FlameWrap>);
    expect(screen.getByText("composer")).toBeVisible();
    const root = container.querySelector("[data-flame-wrap]")!;
    expect(root).toHaveAttribute("data-flame-active", "true");
    expect(root).toHaveAttribute("data-flame-path", "overlay");
    // No WebGL2 in this environment: the wrap reports the degraded state and
    // never leaves a dead canvas over the content.
    await waitFor(() =>
      expect(container.querySelector("[data-flame-output]")).toBeNull(),
    );
    expect(screen.getByText("composer")).toBeVisible();
  });

  it("keeps content mounted but cold while inactive", () => {
    const { container } = render(
      <FlameWrap active={false}>composer</FlameWrap>,
    );
    expect(screen.getByText("composer")).toBeVisible();
    expect(container.querySelector("[data-flame-wrap]")).toHaveAttribute(
      "data-flame-active",
      "false",
    );
    expect(container.querySelector("[data-flame-output]")).toBeNull();
  });

  it("lights the overlay canvas when the component is active", async () => {
    const gl = createMockGL();
    freezeMotion();
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(((
      type: string,
    ) => (type === "webgl2" ? gl : null)) as never);
    const { container, unmount } = render(<FlameWrap>composer</FlameWrap>);
    const output = await waitFor(() => {
      const canvas = container.querySelector("[data-flame-output]");
      expect(canvas).not.toBeNull();
      return canvas as HTMLCanvasElement;
    });
    expect(output).toHaveAttribute("aria-hidden");
    // The overlay extends past the pill on every side; the horizontal budget
    // covers the sideways lean so the flames fade out instead of being cut.
    expect(output.style.right).toBe("-118px");
    expect(output.style.width).toBe("calc(100% + 236px)");
    await waitFor(() => expect(gl.drawArrays).toHaveBeenCalled());
    expect(gl.uniform1f).toHaveBeenCalledWith(
      expect.objectContaining({ name: "uEdgeFade" }),
      118,
    );
    expect(gl.uniform3f).toHaveBeenCalledWith(
      expect.anything(),
      FLAME_PURPLE[0],
      FLAME_PURPLE[1],
      FLAME_PURPLE[2],
    );
    unmount();
    expect(gl.deleteProgram).toHaveBeenCalled();
    expect(gl.deleteTexture).toHaveBeenCalled();
    expect(gl.deleteBuffer).toHaveBeenCalled();
  });
});

describe("createFlameWrap", () => {
  it("returns null instead of throwing when the context is refused", () => {
    const source = document.createElement("canvas");
    const content = document.createElement("div");
    const output = document.createElement("canvas");
    expect(createFlameWrap({ source, content, output })).toBeNull();
  });

  it("draws with clamped options and stops on destroy", async () => {
    const gl = createMockGL();
    freezeMotion();
    const { source, content, output } = elementFixture(gl);
    const instance = createFlameWrap(
      { source, content, output },
      { height: -10, spread: Number.NaN, intensity: -3, radius: -20 },
    );
    expect(instance).not.toBeNull();
    await waitFor(() => expect(gl.drawArrays).toHaveBeenCalledTimes(1));
    const draws = gl.drawArrays.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 40));
    expect(gl.drawArrays.mock.calls.length).toBe(draws);
    instance!.destroy();
    instance!.destroy();
  });
});
