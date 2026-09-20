import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  image: vi.fn(),
  handle: vi.fn(),
  on: vi.fn(),
  dialog: vi.fn(),
  protocol: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("electron", () => ({
  nativeImage: { createFromBuffer: mocks.image },
  ipcMain: { handle: mocks.handle, on: mocks.on },
  dialog: { showOpenDialog: mocks.dialog },
  protocol: { handle: mocks.protocol },
  net: { fetch: mocks.fetch },
}));
import {
  DesktopAppearanceStore,
  isTrustedAppearanceEvent,
  normalizeDesktopPatch,
  registerDesktopAppearance,
} from "./desktop-appearance";

let directory: string;
const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3]);
beforeEach(() => {
  vi.clearAllMocks();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "synax-appearance-test-"));
  mocks.image.mockReturnValue({
    isEmpty: () => false,
    getSize: () => ({ width: 800, height: 600 }),
  });
});
afterEach(() => fs.rmSync(directory, { recursive: true, force: true }));

describe("desktop appearance persistence", () => {
  it("bounds opacity and blur, rejects invalid values, and whitelists scaling modes", () => {
    expect(
      normalizeDesktopPatch({
        opacity: -10,
        blur: 100,
        fit: "contain",
        path: "/private",
      }),
    ).toEqual({ opacity: 0.4, blur: 40, fit: "contain" });
    for (const value of [
      { opacity: NaN },
      { opacity: "0.5" },
      { blur: Infinity },
      { fit: "url(x)" },
      null,
      [],
    ])
      expect(() => normalizeDesktopPatch(value)).toThrow();
  });

  it("restores settings on relaunch and reports unsupported native opacity on Linux", () => {
    const store = new DesktopAppearanceStore(directory, "darwin");
    store.update({ opacity: 0.75, blur: 22, fit: "tile" });
    expect(
      new DesktopAppearanceStore(directory, "darwin").snapshot(),
    ).toMatchObject({
      opacity: 0.75,
      blur: 22,
      fit: "tile",
      opacitySupported: true,
    });
    expect(
      new DesktopAppearanceStore(directory, "linux").snapshot(),
    ).toMatchObject({
      opacity: 1,
      blur: 22,
      fit: "tile",
      opacitySupported: false,
    });
  });

  it("copies images, serves only the active asset, and survives the source being removed", async () => {
    const file = path.join(directory, "风景.png");
    fs.writeFileSync(file, png);
    const store = new DesktopAppearanceStore(directory);
    const first = await store.importBackground(file);
    const cached = store.backgroundPath(first.background!.url)!;
    expect(fs.readFileSync(cached)).toEqual(png);
    fs.unlinkSync(file);
    expect(
      new DesktopAppearanceStore(directory).snapshot().background?.name,
    ).toBe("风景.png");
    expect(
      store.backgroundPath("synax-background://local/../../preferences.json"),
    ).toBeNull();
    expect(
      store.backgroundPath(first.background!.url.replace("local", "evil")),
    ).toBeNull();
    store.removeBackground();
    expect(store.backgroundPath(first.background!.url)).toBeNull();
    expect(
      new DesktopAppearanceStore(directory).snapshot().background,
    ).toBeNull();
  });

  it("preserves the existing image on canceled, invalid, or oversized replacements", async () => {
    const file = path.join(directory, "good.png");
    fs.writeFileSync(file, png);
    const store = new DesktopAppearanceStore(directory);
    const original = await store.importBackground(file);
    const bad = path.join(directory, "bad.png");
    fs.writeFileSync(bad, "not an image");
    await expect(store.importBackground(bad)).rejects.toThrow("INVALID_IMAGE");
    const large = path.join(directory, "large.png");
    fs.writeFileSync(large, "");
    fs.truncateSync(large, 21 * 1024 * 1024);
    await expect(store.importBackground(large)).rejects.toThrow(
      "IMAGE_TOO_LARGE",
    );
    expect(store.snapshot().background).toEqual(original.background);
  });

  it("falls back cleanly when preferences or the cached image are missing", async () => {
    const store = new DesktopAppearanceStore(directory);
    store.update({ opacity: 0.8 });
    const file = path.join(directory, "image.png");
    fs.writeFileSync(file, png);
    const withImage = await store.importBackground(file);
    fs.unlinkSync(store.backgroundPath(withImage.background!.url)!);
    expect(new DesktopAppearanceStore(directory).snapshot()).toMatchObject({
      opacity: 0.8,
      background: null,
    });
    fs.writeFileSync(
      path.join(directory, "appearance/preferences.json"),
      "broken",
    );
    expect(new DesktopAppearanceStore(directory).snapshot().opacity).toBe(1);
  });
});

describe("desktop appearance IPC", () => {
  function windowAndEvent() {
    const frame = { url: "http://localhost:5188/settings" };
    const win = {
      isDestroyed: () => false,
      webContents: { mainFrame: frame },
      setOpacity: vi.fn(),
    };
    const event = { sender: win.webContents, senderFrame: frame };
    return { win, event };
  }
  it("rejects other windows, subframes, and remote origins", () => {
    const { win, event } = windowAndEvent();
    const trust = (e: unknown) =>
      isTrustedAppearanceEvent(e as any, win as any, "http://localhost:5188");
    expect(trust(event)).toBe(true);
    expect(trust({ ...event, sender: {} })).toBe(false);
    expect(
      trust({ ...event, senderFrame: { url: event.senderFrame.url } }),
    ).toBe(false);
    event.senderFrame.url = "http://localhost:5188.evil.example/settings";
    expect(trust(event)).toBe(false);
    event.senderFrame.url = "app://./settings";
    expect(trust(event)).toBe(true);
  });

  it("previews via native setOpacity without writing on every drag; commits persist", async () => {
    const { win, event } = windowAndEvent();
    const store = new DesktopAppearanceStore(directory, "darwin");
    registerDesktopAppearance(store, () => win as any, "http://localhost:5188");
    const preview = mocks.on.mock.calls.find(
      ([name]) => name === "appearance:preview-opacity",
    )![1];
    preview(event, 0.62);
    expect(win.setOpacity).toHaveBeenLastCalledWith(0.62);
    expect(store.snapshot().opacity).toBe(1);
    const update = mocks.handle.mock.calls.find(
      ([name]) => name === "appearance:update",
    )![1];
    expect(update(event, { opacity: 0.62 }).opacity).toBe(0.62);
    expect(
      new DesktopAppearanceStore(directory, "darwin").snapshot().opacity,
    ).toBe(0.62);
    mocks.dialog.mockResolvedValue({ canceled: true, filePaths: [] });
    const choose = mocks.handle.mock.calls.find(
      ([name]) => name === "appearance:choose-background",
    )![1];
    expect(await choose(event)).toBeNull();
    expect(mocks.dialog).toHaveBeenCalledWith(
      win,
      expect.objectContaining({ properties: ["openFile"] }),
    );
  });
});
