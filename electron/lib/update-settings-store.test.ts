import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { UpdateSettingsStore } from "./update-settings-store.js";
import { DEFAULT_UPDATE_SETTINGS } from "../updater/update-settings.js";

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

it("defaults to updates off, persists the source and restores it on restart", async () => {
  const store = new UpdateSettingsStore(file);
  await store.initialize();
  expect(store.settings).toEqual(DEFAULT_UPDATE_SETTINGS);
  const custom = await store.save({
    enabled: true,
    sourceUrl: "https://updates.example/synax",
    mode: "custom",
    customProxyUrl: "https://proxy.example/prefix",
  });
  expect(custom).toEqual({
    enabled: true,
    sourceUrl: "https://updates.example/synax/",
    mode: "custom",
    customProxyUrl: "https://proxy.example/prefix/",
  });
  const restarted = new UpdateSettingsStore(file);
  await restarted.initialize();
  expect(restarted.settings).toEqual(custom);
  await restarted.save({ ...custom, enabled: false });
  expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual({
    ...custom,
    enabled: false,
  });
  expect(await fs.readdir(path.dirname(file))).toEqual(["update-network.json"]);
  custom.enabled = false;
  expect(store.settings.enabled).toBe(true);
});

it("keeps proxy preferences written before online updates were configurable", async () => {
  await fs.mkdir(path.dirname(file));
  await fs.writeFile(
    file,
    JSON.stringify({ mode: "gh-proxy", customProxyUrl: "" }),
  );
  const store = new UpdateSettingsStore(file);
  await store.initialize();
  expect(store.settings).toEqual({
    enabled: false,
    sourceUrl: "",
    mode: "gh-proxy",
    customProxyUrl: "",
  });
});

it("rejects an update source that is not an enterprise HTTPS feed", async () => {
  const store = new UpdateSettingsStore(file);
  for (const sourceUrl of [
    "http://updates.example/synax/",
    "not a URL",
    "https://github.com/coldmint9/Synax/releases/latest/download/",
  ])
    expect(() =>
      store.save({ ...DEFAULT_UPDATE_SETTINGS, enabled: true, sourceUrl }),
    ).toThrow();
  expect(store.settings).toEqual(DEFAULT_UPDATE_SETTINGS);
});

it("does not overwrite saved settings on validation or write failure", async () => {
  const store = new UpdateSettingsStore(file);
  const saved = await store.save({
    enabled: true,
    sourceUrl: "",
    mode: "gh-proxy",
    customProxyUrl: "",
  });
  expect(() =>
    store.save({ ...saved, mode: "custom", customProxyUrl: "http://bad.example" }),
  ).toThrow();
  const rename = vi
    .spyOn(fs, "rename")
    .mockRejectedValueOnce(new Error("disk failure"));
  await expect(store.save(DEFAULT_UPDATE_SETTINGS)).rejects.toThrow(
    "disk failure",
  );
  expect(store.settings).toEqual(saved);
  expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual(saved);
  expect(await fs.readdir(path.dirname(file))).toEqual(["update-network.json"]);
  rename.mockRestore();
  await store.save(DEFAULT_UPDATE_SETTINGS);
  expect(store.settings).toEqual(DEFAULT_UPDATE_SETTINGS);
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
  expect(store.settings).toEqual(DEFAULT_UPDATE_SETTINGS);
  expect(await fs.readFile(file, "utf8")).toBe(contents);
});

it("serializes concurrent writes", async () => {
  const store = new UpdateSettingsStore(file);
  await Promise.all([
    store.save({ ...DEFAULT_UPDATE_SETTINGS, mode: "gh-proxy" }),
    store.save(DEFAULT_UPDATE_SETTINGS),
  ]);
  expect(store.settings).toEqual(DEFAULT_UPDATE_SETTINGS);
  expect(JSON.parse(await fs.readFile(file, "utf8"))).toEqual(
    DEFAULT_UPDATE_SETTINGS,
  );
});
