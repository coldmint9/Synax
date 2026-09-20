import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import {
  dialog,
  ipcMain,
  nativeImage,
  net,
  protocol,
  type BrowserWindow,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
} from "electron";
import type {
  BackgroundFit,
  DesktopAppearance,
  DesktopAppearancePatch,
} from "../appearance-contract.js";

export const BACKGROUND_SCHEME = "synax-background";
const fits: BackgroundFit[] = ["cover", "contain", "fill", "center", "tile"];
const assetPattern = /^[\da-f-]{36}\.(png|jpg)$/;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;

export function normalizeOpacity(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value))
    throw new Error("Invalid window opacity");
  return Math.round(Math.min(1, Math.max(0.4, value)) * 100) / 100;
}

export function normalizeDesktopPatch(value: unknown): DesktopAppearancePatch {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error("Invalid appearance settings");
  const raw = value as Record<string, unknown>;
  const patch: DesktopAppearancePatch = {};
  if ("opacity" in raw) patch.opacity = normalizeOpacity(raw.opacity);
  if ("blur" in raw) {
    if (typeof raw.blur !== "number" || !Number.isFinite(raw.blur))
      throw new Error("Invalid background blur");
    patch.blur = Math.round(Math.min(40, Math.max(0, raw.blur)));
  }
  if ("fit" in raw) {
    if (!fits.includes(raw.fit as BackgroundFit))
      throw new Error("Invalid background fit");
    patch.fit = raw.fit as BackgroundFit;
  }
  return patch;
}

export class DesktopAppearanceStore {
  private value: DesktopAppearance;
  private readonly directory: string;
  private readonly stateFile: string;

  constructor(userData: string, platform: NodeJS.Platform = process.platform) {
    this.directory = path.join(userData, "appearance");
    this.stateFile = path.join(this.directory, "preferences.json");
    this.value = {
      opacity: 1,
      blur: 12,
      fit: "cover",
      background: null,
      opacitySupported: platform === "darwin" || platform === "win32",
    };
    try {
      const saved = JSON.parse(fs.readFileSync(this.stateFile, "utf8"));
      const patch = normalizeDesktopPatch(saved);
      this.value = { ...this.value, ...patch };
      const bg = saved.background;
      if (
        bg &&
        typeof bg.asset === "string" &&
        assetPattern.test(bg.asset) &&
        typeof bg.name === "string" &&
        Number.isFinite(bg.width) &&
        Number.isFinite(bg.height) &&
        bg.width > 0 &&
        bg.height > 0 &&
        fs.existsSync(path.join(this.directory, bg.asset))
      ) {
        this.value.background = {
          asset: bg.asset,
          name: bg.name,
          width: bg.width,
          height: bg.height,
          url: this.imageUrl(bg.asset),
        };
      }
    } catch {
      /* Use defaults for missing or damaged preferences. */
    }
    if (!this.value.opacitySupported) this.value.opacity = 1;
  }

  snapshot(): DesktopAppearance {
    return structuredClone(this.value);
  }

  private imageUrl(asset: string): string {
    return `${BACKGROUND_SCHEME}://local/${asset}`;
  }

  private commit(next: DesktopAppearance): DesktopAppearance {
    fs.mkdirSync(this.directory, { recursive: true });
    const temporary = `${this.stateFile}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
    fs.renameSync(temporary, this.stateFile);
    this.value = next;
    return this.snapshot();
  }

  update(raw: unknown): DesktopAppearance {
    const patch = normalizeDesktopPatch(raw);
    if (!this.value.opacitySupported) patch.opacity = 1;
    return this.commit({ ...this.value, ...patch });
  }

  async importBackground(filePath: string): Promise<DesktopAppearance> {
    // Only called with a path returned by the main process's native picker.
    const file = await fs.promises.open(filePath, "r");
    let bytes: Buffer;
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.size > MAX_IMAGE_BYTES)
        throw new Error("IMAGE_TOO_LARGE");
      bytes = await file.readFile();
      if (bytes.length > MAX_IMAGE_BYTES) throw new Error("IMAGE_TOO_LARGE");
    } finally {
      await file.close();
    }
    const png = bytes
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const jpeg = bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
    if (!png && !jpeg) throw new Error("INVALID_IMAGE");
    const image = nativeImage.createFromBuffer(bytes);
    if (image.isEmpty()) throw new Error("INVALID_IMAGE");
    const { width, height } = image.getSize();
    if (width * height > 40_000_000 || Math.max(width, height) > 16_000)
      throw new Error("IMAGE_TOO_LARGE");
    const asset = `${randomUUID()}.${png ? "png" : "jpg"}`;
    const target = path.join(this.directory, asset);
    fs.mkdirSync(this.directory, { recursive: true });
    // Keep the source encoding, including JPEG orientation metadata.
    await fs.promises.writeFile(target, bytes, { flag: "wx", mode: 0o600 });
    const previous = this.value.background;
    try {
      this.commit({
        ...this.value,
        background: {
          asset,
          name: path.basename(filePath),
          width,
          height,
          url: this.imageUrl(asset),
        },
      });
    } catch (error) {
      await fs.promises.unlink(target).catch(() => {});
      throw error;
    }
    if (previous)
      await fs.promises
        .unlink(path.join(this.directory, previous.asset))
        .catch(() => {});
    return this.snapshot();
  }

  removeBackground(): DesktopAppearance {
    const previous = this.value.background;
    const next = this.commit({ ...this.value, background: null });
    if (previous)
      fs.promises
        .unlink(path.join(this.directory, previous.asset))
        .catch(() => {});
    return next;
  }

  backgroundPath(url: string): string | null {
    const parsed = new URL(url);
    const asset = parsed.pathname.slice(1);
    if (
      parsed.protocol !== `${BACKGROUND_SCHEME}:` ||
      parsed.hostname !== "local" ||
      !assetPattern.test(asset) ||
      asset !== this.value.background?.asset
    )
      return null;
    return path.join(this.directory, asset);
  }
}

export function isTrustedAppearanceEvent(
  event: IpcMainEvent | IpcMainInvokeEvent,
  win: BrowserWindow | null,
  devOrigin: string | null,
): boolean {
  if (
    !win ||
    win.isDestroyed() ||
    event.sender !== win.webContents ||
    event.senderFrame !== win.webContents.mainFrame
  )
    return false;
  try {
    const url = new URL(event.senderFrame.url);
    return (
      (url.protocol === "app:" && url.hostname === ".") ||
      (devOrigin !== null && url.origin === devOrigin)
    );
  } catch {
    return false;
  }
}

export function registerDesktopAppearance(
  store: DesktopAppearanceStore,
  getWindow: () => BrowserWindow | null,
  devOrigin: string | null,
): void {
  const trustedWindow = (event: IpcMainEvent | IpcMainInvokeEvent) => {
    const win = getWindow();
    if (!isTrustedAppearanceEvent(event, win, devOrigin))
      throw new Error("Untrusted appearance request");
    return win!;
  };
  ipcMain.handle("appearance:get", (event) => {
    trustedWindow(event);
    return store.snapshot();
  });
  ipcMain.handle("appearance:update", (event, patch) => {
    const win = trustedWindow(event);
    const next = store.update(patch);
    if (next.opacitySupported) win.setOpacity(next.opacity);
    return next;
  });
  ipcMain.on("appearance:preview-opacity", (event, opacity) => {
    if (
      !isTrustedAppearanceEvent(event, getWindow(), devOrigin) ||
      !store.snapshot().opacitySupported
    )
      return;
    if (typeof opacity === "number" && Number.isFinite(opacity))
      getWindow()!.setOpacity(normalizeOpacity(opacity));
  });
  let choosing = false;
  ipcMain.handle("appearance:choose-background", async (event) => {
    const win = trustedWindow(event);
    if (choosing) return null;
    choosing = true;
    try {
      const result = await dialog.showOpenDialog(win, {
        properties: ["openFile"],
        filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg"] }],
      });
      if (result.canceled || !result.filePaths[0]) return null;
      return await store.importBackground(result.filePaths[0]);
    } finally {
      choosing = false;
    }
  });
  ipcMain.handle("appearance:remove-background", (event) => {
    trustedWindow(event);
    return store.removeBackground();
  });
  protocol.handle(BACKGROUND_SCHEME, (request) => {
    const filePath = store.backgroundPath(request.url);
    return filePath
      ? net.fetch(pathToFileURL(filePath).href)
      : new Response("Not found", { status: 404 });
  });
}
