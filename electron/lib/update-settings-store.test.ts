import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UpdateSettingsStore } from "./update-settings-store.js";
import { DEFAULT_UPDATE_NETWORK } from "./update-network.js";

let directory: string;
let file: string;
beforeEach(async () => {
  directory = await fs.mkdtemp(
    path.join(os.tmpdir(), "synax-update-settings-"),
  );
  file = path.join(directory, "profile", "update-network.json");
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(directory, { force: true, recursive: true });
});

it("defaults to direct, persists normalized preferences and restores them on restart", async () => {
  const store = new UpdateSettingsStore(file);
  await store.initialize();
  expect(store.settings).toEqual(DEFAULT_UPDATE_NETWORK);
  const custom = await store.save({
    mode: "custom",
    customProxyUrl: "https://proxy.example/prefix",
  });
  expect(custom.customProxyUrl).toBe("https://proxy.example/prefix/");
  const restarted = new UpdateSettingsStore(file);
  await restarted.initialize();
  expect(restarted.settings).toEqual(custom);
  await restarted.save({ ...custom, mode: "direct" });
  expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({
    ...custom,
    mode: "direct",
  });
  expect(await fs.readdir(path.dirname(file))).toEqual(["update-network.json"]);
  custom.mode = "direct";
  expect(store.settings.mode).toBe("custom");
});

it("does not overwrite saved settings on validation or write failure", async () => {
  const store = new UpdateSettingsStore(file);
  await store.save({ mode: "gh-proxy", customProxyUrl: "" });
  expect(() =>
    store.save({ mode: "custom", customProxyUrl: "http://bad.example" }),
  ).toThrow();
  const rename = vi
    .spyOn(fs, "rename")
    .mockRejectedValueOnce(new Error("disk failure"));
  await expect(store.save(DEFAULT_UPDATE_NETWORK)).rejects.toThrow(
    "disk failure",
  );
  expect(store.settings.mode).toBe("gh-proxy");
  expect(JSON.parse(await fs.readFile(file, "utf8")).mode).toBe("gh-proxy");
  expect(await fs.readdir(path.dirname(file))).toEqual(["update-network.json"]);
  rename.mockRestore();
  await store.save(DEFAULT_UPDATE_NETWORK);
  expect(store.settings).toEqual(DEFAULT_UPDATE_NETWORK);
});

it.each([
  "broken json",
  JSON.stringify({ mode: "custom", customProxyUrl: "http://bad.example" }),
])("tolerates corrupt stored preferences", async (contents) => {
  await fs.mkdir(path.dirname(file));
  await fs.writeFile(file, contents);
  vi.spyOn(console, "warn").mockImplementation(() => {});
  const store = new UpdateSettingsStore(file);
  await store.initialize();
  expect(store.settings).toEqual(DEFAULT_UPDATE_NETWORK);
  expect(await fs.readFile(file, "utf8")).toBe(contents);
});

it("serializes concurrent writes", async () => {
  const store = new UpdateSettingsStore(file);
  await Promise.all([
    store.save({ mode: "gh-proxy", customProxyUrl: "" }),
    store.save(DEFAULT_UPDATE_NETWORK),
  ]);
  expect(store.settings).toEqual(DEFAULT_UPDATE_NETWORK);
  expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual(
    DEFAULT_UPDATE_NETWORK,
  );
});
