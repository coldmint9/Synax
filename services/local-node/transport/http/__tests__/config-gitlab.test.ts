import fs from "node:fs";
import { afterEach, expect, it, vi } from "vitest";
import { configRoutes } from "../config.js";
import {
  getGlobalConfigFilePath,
  getGitLabTokenForHost,
} from "../../../infrastructure/runtime/config/config-store.js";

const save = (accounts: unknown[]) =>
  configRoutes.request("http://localhost/global", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ gitLab: { accounts } }),
  });
afterEach(() => vi.unstubAllGlobals());

it("encrypts tokens across updates, preserves them only on the same host and supports logout", async () => {
  let response = await save([
    { host: "GITLAB.COM:443", token: "glpat-test-private-secret" },
  ]);
  expect(response.status).toBe(200);
  let body = await response.json();
  expect(body.config.gitLab.accounts[0]).toEqual({
    host: "gitlab.com",
    tokenMasked: expect.any(String),
  });
  expect(JSON.stringify(body)).not.toContain("glpat-test-private-secret");
  let disk = fs.readFileSync(getGlobalConfigFilePath(), "utf8");
  expect(disk).toContain("enc:v1:");
  expect(disk).not.toContain("glpat-test-private-secret");
  expect(getGitLabTokenForHost("gitlab.com")).toBe("glpat-test-private-secret");
  response = await save([
    { host: "gitlab.com" },
    { host: "gitlab.work.test", token: "work-secret" },
  ]);
  expect(response.status).toBe(200);
  expect(getGitLabTokenForHost("gitlab.com")).toBe("glpat-test-private-secret");
  await configRoutes.request("http://localhost/global", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ inputOptimizationModel: "" }),
  });
  disk = fs.readFileSync(getGlobalConfigFilePath(), "utf8");
  expect(disk).not.toContain("glpat-test-private-secret");
  expect(disk).not.toContain("work-secret");
  await save([{ host: "gitlab.work.test" }]);
  expect(getGitLabTokenForHost("gitlab.com")).toBeUndefined();
  expect(getGitLabTokenForHost("gitlab.work.test")).toBe("work-secret");
  await save([{ host: "gitlab.work.test", token: "" }]);
  expect(getGitLabTokenForHost("gitlab.work.test")).toBeUndefined();
  await save([]);
  body = await (await configRoutes.request("http://localhost/global")).json();
  expect(body.config.gitLab.accounts).toEqual([]);
});

it("never reuses a masked secret for a different host", async () => {
  const body = await (
    await save([{ host: "gitlab.com", token: "source-secret" }])
  ).json();
  await save([{ ...body.config.gitLab.accounts[0], host: "other.test" }]);
  expect(getGitLabTokenForHost("other.test")).toBeUndefined();
  expect(getGitLabTokenForHost("gitlab.com")).toBeUndefined();
});

it.each(
  [
    [{ host: "https://gitlab.com", token: "test" }],
    [{ host: "gitlab.com:99999", token: "test" }],
    [{ host: "gitlab.com", token: "test\nheader" }],
    [{ host: "gitlab.com", token: "enc:v1:injected" }],
    [{ host: "gitlab.com" }, { host: "GITLAB.COM:443" }],
  ].map((accounts) => [accounts]),
)("rejects invalid credentials without echoing tokens", async (accounts) => {
  expect((await save(accounts)).status).toBe(400);
});

it("validates a draft without saving it, and can validate a saved credential", async () => {
  const fetchMock = vi
    .fn()
    .mockImplementation(async () =>
      Response.json({
        id: 1,
        username: "mint",
        name: "Mint",
        email: "private@example.test",
      }),
    );
  vi.stubGlobal("fetch", fetchMock);
  const validate = (value: unknown) =>
    configRoutes.request("http://localhost/gitlab/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(value),
    });
  await save([]);
  const response = await validate({ host: "gitlab.com", token: "draft-token" });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    host: "gitlab.com",
    username: "mint",
    name: "Mint",
  });
  expect(getGitLabTokenForHost("gitlab.com")).toBeUndefined();
  await save([{ host: "gitlab.com", token: "saved-token" }]);
  expect((await validate({ host: "gitlab.com" })).status).toBe(200);
  expect(fetchMock.mock.lastCall?.[1].headers["PRIVATE-TOKEN"]).toBe(
    "saved-token",
  );
  expect((await validate({ host: "unconfigured.test" })).status).toBe(403);
  expect((await validate({ host: "https://bad.test" })).status).toBe(400);
});
