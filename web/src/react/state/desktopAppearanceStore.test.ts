import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useDesktopAppearance } from "./desktopAppearanceStore";
import type { DesktopAppearance } from "../../../../electron/appearance-contract";

const initial: DesktopAppearance = {
  opacity: 1,
  blur: 12,
  fit: "cover",
  background: null,
  opacitySupported: true,
};
const api = {
  get: vi.fn(),
  update: vi.fn(),
  previewOpacity: vi.fn(),
  chooseBackground: vi.fn(),
  removeBackground: vi.fn(),
};
beforeEach(() => {
  vi.resetAllMocks();
  (window as any).electronAPI = { appearance: api };
  api.get.mockResolvedValue(initial);
  useDesktopAppearance.setState({ settings: null, error: null, busy: false });
});
afterEach(() => {
  delete (window as any).electronAPI;
});

it("previews immediately and persists only when committed", async () => {
  await useDesktopAppearance.getState().load();
  useDesktopAppearance.getState().preview({ opacity: 0.72, blur: 24 });
  expect(api.previewOpacity).toHaveBeenCalledWith(0.72);
  expect(api.update).not.toHaveBeenCalled();
  expect(useDesktopAppearance.getState().settings?.blur).toBe(24);
  api.update.mockResolvedValue({ ...initial, opacity: 0.72, blur: 24 });
  await useDesktopAppearance.getState().update({ opacity: 0.72, blur: 24 });
  expect(useDesktopAppearance.getState()).toMatchObject({
    settings: { opacity: 0.72 },
    busy: false,
    error: null,
  });
});

it("restores saved native opacity when a save fails and preserves canceled image choices", async () => {
  await useDesktopAppearance.getState().load();
  useDesktopAppearance.getState().preview({ opacity: 0.5 });
  api.update.mockRejectedValue(new Error("Disk full"));
  await useDesktopAppearance.getState().update({ opacity: 0.5 });
  expect(useDesktopAppearance.getState()).toMatchObject({
    settings: { opacity: 1 },
    error: "Disk full",
    busy: false,
  });
  expect(api.previewOpacity).toHaveBeenLastCalledWith(1);
  api.chooseBackground.mockResolvedValue(null);
  await useDesktopAppearance.getState().chooseBackground();
  expect(useDesktopAppearance.getState().settings).toEqual(initial);
});

it("does not let an older response overwrite a later edit", async () => {
  await useDesktopAppearance.getState().load();
  let resolve!: (settings: DesktopAppearance) => void;
  api.update
    .mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    )
    .mockResolvedValueOnce({ ...initial, fit: "contain" });
  const first = useDesktopAppearance.getState().update({ fit: "cover" });
  await useDesktopAppearance.getState().update({ fit: "contain" });
  resolve(initial);
  await first;
  expect(useDesktopAppearance.getState().settings?.fit).toBe("contain");
});

it("keeps sliders enabled and preserves a new drag while an earlier save finishes", async () => {
  await useDesktopAppearance.getState().load();
  let resolve!: (settings: DesktopAppearance) => void;
  api.update.mockImplementationOnce(
    () =>
      new Promise((done) => {
        resolve = done;
      }),
  );
  const saving = useDesktopAppearance.getState().update({ opacity: 0.8 });
  expect(useDesktopAppearance.getState().busy).toBe(false);
  useDesktopAppearance.getState().preview({ opacity: 0.6 });
  resolve({ ...initial, opacity: 0.8 });
  await saving;
  expect(useDesktopAppearance.getState().settings?.opacity).toBe(0.6);
});
