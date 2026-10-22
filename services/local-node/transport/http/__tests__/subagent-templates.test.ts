import { beforeEach, expect, it } from "vitest";
import { subagentTemplateRoutes as routes } from "../subagent-templates.js";
import { resetAgentRuntimeFixtures } from "../../../modules/agent-runtime/__tests__/agent-runtime-fixtures.js";
import { businessStore } from "../../../infrastructure/persistence/business-store.js";
import { subagentTemplates } from "../../../modules/agent-runtime/subagent-templates.js";
beforeEach(resetAgentRuntimeFixtures);
const body = { name: "测试助手", description: "补充回归覆盖", instructions: "运行相关测试，返回失败原因。" };
const json = (method: string, data: unknown) => ({ method, headers: { "content-type": "application/json" }, body: JSON.stringify(data) });
it("persists creates, edits and deletes before acknowledging them", async () => {
  const created = await routes.request("/", json("POST", body));
  expect(created.status).toBe(201);
  const { item } = await created.json();
  await businessStore.refresh(["subagent-templates"]);
  expect(subagentTemplates.get(item.id)).toMatchObject(body);
  expect((await (await routes.request("/")).json()).items).toHaveLength(1);
  const changed = await routes.request(`/${item.id}`, json("PUT", { ...body, name: "新名称", access: "read-only" }));
  expect(changed.status).toBe(200);
  await businessStore.refresh(["subagent-templates"]);
  expect(subagentTemplates.get(item.id)).toMatchObject({ name: "新名称", access: "read-only" });
  expect((await routes.request(`/${item.id}`, { method: "DELETE" })).status).toBe(200);
  expect((await (await routes.request("/")).json()).items).toEqual([]);
});
it("validates input and does not create an entry on an unknown update", async () => {
  expect((await routes.request("/", json("POST", { ...body, name: " " }))).status).toBe(400);
  expect((await routes.request("/", json("POST", { ...body, writeScope: ["../outside"] }))).status).toBe(400);
  expect((await routes.request("/missing", json("PUT", body))).status).toBe(404);
  expect((await (await routes.request("/")).json()).items).toEqual([]);
});
