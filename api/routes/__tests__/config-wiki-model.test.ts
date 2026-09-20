import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

let root: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "synax-wiki-model-"));
  vi.stubEnv("DATA_ROOT", root);
  vi.stubEnv("CONFIG_ENCRYPTION_KEY", "wiki-model-test");
  vi.resetModules();
});
afterEach(async () => {
  (await import("../../db/index.js")).closeDb();
  vi.unstubAllEnvs();
  fs.rmSync(root, { recursive: true, force: true });
});
async function update(wikiModel: unknown) {
  const { configRoutes } = await import("../config.js");
  return configRoutes.request("http://localhost/global", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ wikiModel }),
  });
}

it("persists the Wiki model independently and supports returning to default selection", async () => {
  const { getGlobalConfig } = await import("../../lib/config/config-store.js");
  const before = getGlobalConfig();
  const provider = before.providers.find((item) => item.id === "openai")!;
  const model = `openai/${provider.models[0].id}`;
  expect((await update(model)).status).toBe(200);
  expect(getGlobalConfig().wikiModel).toBe(model);
  expect(getGlobalConfig().defaultApiProviderId).toBe(
    before.defaultApiProviderId,
  );
  expect(
    JSON.parse(
      fs.readFileSync(path.join(root, "config/global-config.json"), "utf8"),
    ).wikiModel,
  ).toBe(model);
  const { getWikiWorkflowModel } =
    await import("../../services/wiki/wiki-model.js");
  expect(getWikiWorkflowModel()).toBe(model);
  expect((await update("")).status).toBe(200);
  expect(getWikiWorkflowModel()).toBeUndefined();
});

it("rejects missing models and ACP backends without changing the Wiki setting", async () => {
  for (const value of [
    "unknown/model",
    "openai/missing-model",
    "codex-acp/default",
    "not-qualified",
    42,
  ]) {
    expect((await update(value)).status).toBe(400);
  }
  const { getGlobalConfig } = await import("../../lib/config/config-store.js");
  expect(getGlobalConfig().wikiModel).toBe("");
});
