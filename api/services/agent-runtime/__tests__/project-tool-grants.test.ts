import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it } from "vitest";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeRoutes } from "../../../routes/agent-runtime.js";
import { agentRuntimeStore } from "../session-store.js";
import { toolRegistry } from "../tool-registry.js";
import { permissionPolicy } from "../permission-policy.js";
import {
  hasProjectToolGrant,
  listProjectToolGrants,
  revokeProjectToolGrant,
} from "../project-tool-grants.js";
import { applySessionPermissionUpdate } from "../session-permissions.js";
import { setSessionWorkspaceRoot, clearSessionWorkspaceRoot } from "../tools/workspace.js";
import { ensureSynaxAgentRegistered } from "../synax/index.js";
import { resetAgentRuntimeFixtures } from "./agent-runtime-fixtures.js";

let dir: string;
const sessions: string[] = [];
function create(projectId: string) {
  const session = agentSessionRuntime.create({
    projectId,
    profileId: "synax",
    prompt: "Grant verification",
    permissionTier: "boundary",
  });
  sessions.push(session.id);
  setSessionWorkspaceRoot(session.id, path.join(dir, "workspace"));
  return session.id;
}

beforeEach(() => {
  resetAgentRuntimeFixtures();
  ensureSynaxAgentRegistered();
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "synax-tool-grants-"));
  fs.mkdirSync(path.join(dir, "workspace"));
  fs.writeFileSync(path.join(dir, "outside-a.txt"), "alpha");
  fs.writeFileSync(path.join(dir, "outside-b.txt"), "bravo");
});
afterEach(() => {
  for (const id of sessions.splice(0)) clearSessionWorkspaceRoot(id);
  fs.rmSync(dir, { recursive: true, force: true });
});

it("approves all future operations of one tool in this project, including new sessions", async () => {
  const first = create("grant-project");
  const request = await toolRegistry.execute(first, "file.read", { path: path.join(dir, "outside-a.txt") });
  expect(request.permission).toMatchObject({ action: "ask", metadata: { allowedReplies: ["once", "always", "reject"] } });
  const approved = permissionPolicy.reply(first, request.permission!.id, "always");
  expect(listProjectToolGrants("grant-project").map((item) => item.toolId)).toEqual(["file.read"]);
  const resumed = await toolRegistry.resumePending(first, approved);
  expect(resumed.record.status).toBe("completed");

  const second = create("grant-project");
  const otherPath = path.join(dir, "outside-b.txt");
  const subsequent = await toolRegistry.execute(second, "file.read", { path: otherPath });
  expect(subsequent.permission?.action).toBe("allow");
  expect(subsequent.record.status).toBe("completed");
  expect(JSON.stringify(subsequent.record.outputRef)).toContain("bravo");
  expect((await toolRegistry.execute(second, "file.delete", { path: otherPath })).permission?.action).toBe("ask");
  expect((await toolRegistry.execute(create("another-project"), "file.read", { path: otherPath })).permission?.action).toBe("ask");
});

it("does not override explicit deny and revocation affects later requests", async () => {
  const id = create("deny-project");
  const first = await toolRegistry.execute(id, "file.read", { path: path.join(dir, "outside-a.txt") });
  const approved = permissionPolicy.reply(id, first.permission!.id, "always");
  expect(hasProjectToolGrant(id, "file.read")).toBe(true);
  const resumed = await toolRegistry.resumePending(id, approved);
  expect(resumed.record.status).toBe("completed");
  applySessionPermissionUpdate(id, { permissionOverrides: { read: "deny" } });
  expect((await toolRegistry.execute(id, "file.read", { path: path.join(dir, "outside-b.txt") })).permission?.action).toBe("deny");
  applySessionPermissionUpdate(id, { permissionOverrides: { read: "allow" } });
  const queued = await toolRegistry.execute(id, "file.read", { path: path.join(dir, "outside-b.txt") });
  expect(queued.record.status).toBe("completed");
  expect(revokeProjectToolGrant("deny-project", "file.read")).toBe(true);
  expect(hasProjectToolGrant(id, "file.read")).toBe(false);
  expect((await toolRegistry.execute(id, "file.read", { path: path.join(dir, "outside-b.txt") })).permission?.action).toBe("ask");
});

it("does not run a newly granted pending tool after its grant has been revoked", async () => {
  const id = create("revoke-pending-project");
  const request = await toolRegistry.execute(id, "file.read", { path: path.join(dir, "outside-a.txt") });
  const approval = permissionPolicy.reply(id, request.permission!.id, "always");
  expect(revokeProjectToolGrant("revoke-pending-project", "file.read")).toBe(true);
  const result = await toolRegistry.resumePending(id, approval);
  expect(result.record.status).toBe("denied");
  expect(result.record.error).toMatch(/revoked/);
});

it("rechecks explicit restrictions before executing an approved pending request", async () => {
  const id = create("deny-pending-project");
  const request = await toolRegistry.execute(id, "file.read", { path: path.join(dir, "outside-a.txt") });
  const approval = permissionPolicy.reply(id, request.permission!.id, "always");
  applySessionPermissionUpdate(id, { permissionOverrides: { read: "deny" } });
  const result = await toolRegistry.resumePending(id, approval);
  expect(result.record.status).toBe("denied");
  expect(result.record.error).toMatch(/explicit permission restriction/);
});

it("allows all shell commands after a project-level shell grant, not other tools", async () => {
  const id = create("shell-project");
  const first = await toolRegistry.execute(id, "bash", { command: "echo first > output.txt" });
  expect(first.permission?.action).toBe("ask");
  const approval = permissionPolicy.reply(id, first.permission!.id, "always");
  expect((await toolRegistry.resumePending(id, approval)).record.status).toBe("completed");
  const second = await toolRegistry.execute(id, "bash", { command: "echo second > output.txt" });
  expect(second.permission?.action).toBe("allow");
  expect(second.record.status).toBe("completed");
  expect(fs.readFileSync(path.join(dir, "workspace", "output.txt"), "utf8").trim()).toBe("second");
  expect(hasProjectToolGrant(id, "file.read")).toBe(false);
});

it("exposes project grants and revocation through the runtime API", async () => {
  const id = create("route-project");
  const request = await toolRegistry.execute(id, "file.read", { path: path.join(dir, "outside-a.txt") });
  const response = await agentRuntimeRoutes.request(
    `/sessions/${id}/permissions/${request.permission!.id}/reply`,
    { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ reply: "always" }) },
  );
  expect(response.status).toBe(200);
  const list = await agentRuntimeRoutes.request("/projects/route-project/tool-grants");
  expect((await list.json() as { items: Array<{ toolId: string }> }).items.map((item) => item.toolId)).toEqual(["file.read"]);
  const revoke = await agentRuntimeRoutes.request("/projects/route-project/tool-grants/file.read", { method: "DELETE" });
  expect(revoke.status).toBe(200);
  expect(listProjectToolGrants("route-project")).toEqual([]);
});

it("applies a file.delete grant to later external targets without widening other tools", async () => {
  const id = create("delete-project");
  const first = await toolRegistry.execute(id, "file.delete", { path: path.join(dir, "outside-a.txt") });
  expect(first.permission?.action).toBe("ask");
  const approval = permissionPolicy.reply(id, first.permission!.id, "always");
  expect((await toolRegistry.resumePending(id, approval)).record.status).toBe("completed");
  const next = await toolRegistry.execute(id, "file.delete", { path: path.join(dir, "outside-b.txt") });
  expect(next.permission?.action).toBe("allow");
  expect(next.record.status).toBe("completed");
  expect(fs.existsSync(path.join(dir, "outside-b.txt"))).toBe(false);
  expect(hasProjectToolGrant(id, "file.write")).toBe(false);
});

it("rejects a missing or forged tool call instead of persisting a grant", () => {
  const id = create("forged-project");
  const session = agentRuntimeStore.getSession(id);
  const request = permissionPolicy.evaluate({
    sessionId: id, category: "read", internalGate: "external_path",
    rules: session.permissionRules,
    metadata: { toolId: "file.read", args: { path: path.join(dir, "outside-a.txt") } },
  });
  expect(request.action).toBe("ask");
  expect(() => permissionPolicy.reply(id, request.id, "always")).toThrow();
  expect(listProjectToolGrants("forged-project")).toEqual([]);
});
