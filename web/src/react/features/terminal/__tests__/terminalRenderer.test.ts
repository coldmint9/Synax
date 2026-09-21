import { expect, it, vi } from "vitest";
import { enableWebglRenderer } from "../terminalRenderer";

it("uses WebGL and falls back to DOM after context loss", () => {
  let contextLost: (() => void) | undefined;
  const addon = {
    dispose: vi.fn(),
    onContextLoss: vi.fn((listener: () => void) => {
      contextLost = listener;
      return { dispose: vi.fn() };
    }),
  };
  const terminal = { loadAddon: vi.fn() };
  const renderer = vi.fn();

  expect(enableWebglRenderer(terminal as never, renderer, () => addon)).toBe(
    addon,
  );
  expect(renderer).toHaveBeenLastCalledWith("webgl");
  contextLost?.();
  expect(addon.dispose).toHaveBeenCalledOnce();
  expect(renderer).toHaveBeenLastCalledWith("dom");
});

it("continues with DOM rendering when WebGL initialization fails", () => {
  const terminal = {
    loadAddon: vi.fn(() => {
      throw new Error("WebGL unavailable");
    }),
  };
  const renderer = vi.fn();
  const addon = { dispose: vi.fn(), onContextLoss: vi.fn() };

  expect(
    enableWebglRenderer(terminal as never, renderer, () => addon as never),
  ).toBeUndefined();
  expect(addon.dispose).toHaveBeenCalledOnce();
  expect(renderer).toHaveBeenLastCalledWith("dom");
});
