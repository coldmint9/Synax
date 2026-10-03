import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { agentSessionRuntime } from "../session-runtime.js";
import { agentRuntimeStore } from "../session-store.js";
import { permissionPolicy } from "../permission-policy.js";
import {
  applySessionPermissionUpdate,
  readSessionPermissionConfig,
} from "../session-permissions.js";
import { permissionTierFromRules } from "../permission-tiers.js";
import { ensureSynaxAgentRegistered } from "../synax/index.js";
import { toolRegistry } from "../tool-registry.js";
import {
  setSessionWorkspaceRoot,
  clearSessionWorkspaceRoot,
} from "../tools/workspace.js";
import { sandboxPolicy } from "../sandbox/index.js";
import { resetAgentRuntimeFixtures } from "./agent-runtime-fixtures.js";

let directory: string;
let sessionId: string;
beforeEach(() => {
  resetAgentRuntimeFixtures();
  ensureSynaxAgentRegistered();
  directory = fs.mkdtempSync(path.join(os.tmpdir(), "synax-approval-"));
  fs.mkdirSync(path.join(directory, "workspace"));
  fs.writeFileSync(path.join(directory, "outside.txt"), "external contents");
  const session = agentSessionRuntime.create({
    projectId: "approval-test",
    profileId: "synax",
    prompt: "Inspect files",
    permissionTier: "boundary",
  });
  sessionId = session.id;
  setSessionWorkspaceRoot(sessionId, path.join(directory, "workspace"));
});
afterEach(() => {
  vi.unstubAllEnvs();
  clearSessionWorkspaceRoot(sessionId);
  fs.rmSync(directory, { recursive: true, force: true });
});
const network = () =>
  permissionPolicy.evaluate({
    sessionId,
    category: "read",
    internalGate: "none",
    rules: agentRuntimeStore.getSession(sessionId).permissionRules,
    metadata: { toolId: "webSearch", args: { query: "public documentation" } },
  });

it("keeps old blanket grants from bypassing boundary review without a tool grant", async () => {
  agentRuntimeStore.updateSessionMetadata(sessionId, {
    alwaysPermissionRules: [{ gate: "*", pattern: "*", action: "allow" }],
  });
  applySessionPermissionUpdate(sessionId, { permissionTier: "boundary" });
  expect(network()).toMatchObject({
    action: "ask",
    internalGate: "network",
    metadata: { allowedReplies: ["once", "reject"] },
  });
  const file = path.join(directory, "outside.txt");
  const first = await toolRegistry.execute(sessionId, "file.read", {
    path: file,
  });
  expect(first.permission).toMatchObject({
    action: "ask",
    internalGate: "external_path",
  });
  expect(first.permission?.metadata?.allowedReplies).toEqual(["once", "always", "reject"]);
  const approved = permissionPolicy.reply(
    sessionId,
    first.permission!.id,
    "once",
  );
  const result = await toolRegistry.resumePending(sessionId, approved);
  expect(result.record.status).toBe("completed");
  expect(JSON.stringify(result.record.outputRef)).toContain(
    "external contents",
  );
  expect(() =>
    sandboxPolicy.resolve(
      file,
      path.join(directory, "workspace"),
      sessionId,
      "file.read",
    ),
  ).toThrow();
  expect(
    (await toolRegistry.execute(sessionId, "file.read", { path: file }))
      .permission?.action,
  ).toBe("ask");
});

it("does not let a symlink change enlarge a one-operation approval", async () => {
  const link = path.join(directory, "workspace", "link");
  fs.symlinkSync(path.join(directory, "outside.txt"), link);
  const pending = await toolRegistry.execute(sessionId, "file.read", {
    path: "link",
  });
  expect(pending.permission?.action).toBe("ask");
  const approved = permissionPolicy.reply(
    sessionId,
    pending.permission!.id,
    "once",
  );
  fs.writeFileSync(path.join(directory, "other.txt"), "not approved");
  fs.unlinkSync(link);
  fs.symlinkSync(path.join(directory, "other.txt"), link);
  const result = await toolRegistry.resumePending(sessionId, approved);
  expect(result.record.status).toBe("denied");
  expect(JSON.stringify(result.record.outputRef)).not.toContain("not approved");
});

it("auto-reviews known read-only work but asks for unsafe and uncertain commands", () => {
  applySessionPermissionUpdate(sessionId, { permissionTier: "auto" });
  expect(network().action).toBe("allow");
  const evaluate = (command: string) =>
    permissionPolicy.evaluateShellCommand({
      sessionId,
      category: "shell",
      internalGate: "shell",
      command,
      rules: agentRuntimeStore.getSession(sessionId).permissionRules,
    }).action;
  expect(evaluate("ls .")).toBe("allow");
  for (const command of [
    "rm -rf .",
    "curl example.test",
    "awk system",
    "rg --pre sh .",
    'cat "secret file"',
    "cat $(printf /etc/passwd)",
    "node server.js &",
  ])
    expect(evaluate(command)).toBe("ask");
  fs.symlinkSync(
    path.join(directory, "outside.txt"),
    path.join(directory, "workspace", "secret"),
  );
  expect(evaluate("cat secret")).toBe("ask");
  applySessionPermissionUpdate(sessionId, { permissionTier: "unrestricted" });
  expect(evaluate("curl example.test")).toBe("allow");
  expect(network().action).toBe("allow");
});

it("updates child restrictions as well as the running parent and migrates old modes conservatively", () => {
  expect(
    readSessionPermissionConfig({ permissionTier: "readonly" }).permissionTier,
  ).toBe("boundary");
  expect(
    readSessionPermissionConfig({ permissionTier: "readwrite" }).permissionTier,
  ).toBe("boundary");
  applySessionPermissionUpdate(sessionId, { permissionTier: "unrestricted" });
  const child = agentSessionRuntime.create({
    projectId: "approval-test",
    profileId: "explorer",
    parentSessionId: sessionId,
    prompt: "read",
  });
  applySessionPermissionUpdate(sessionId, { permissionTier: "boundary" });
  expect(
    permissionTierFromRules(
      agentRuntimeStore.getSession(child.id).permissionRules,
    ),
  ).toBe("boundary");
  expect(network().action).toBe("ask");
});

it.skipIf(process.platform === "win32")(
  "auto-reviews public system reference reads, without auto-reading private external files",
  async () => {
    applySessionPermissionUpdate(sessionId, { permissionTier: "auto" });
    const publicRead = await toolRegistry.execute(sessionId, "file.read", {
      path: "/etc/hosts",
    });
    expect(publicRead.permission?.action).toBe("allow");
    expect(publicRead.record.status).toBe("completed");
    expect(
      (
        await toolRegistry.execute(sessionId, "file.read", {
          path: path.join(directory, "outside.txt"),
        })
      ).permission?.action,
    ).toBe("ask");
    applySessionPermissionUpdate(sessionId, { permissionTier: "boundary" });
    expect(
      (
        await toolRegistry.execute(sessionId, "file.read", {
          path: "/etc/hosts",
        })
      ).permission?.action,
    ).toBe("ask");
  },
);

it("asks for native requests whose actual scope is unknown rather than trusting their read/edit label", () => {
  const request = permissionPolicy.evaluate({
    sessionId,
    category: "write",
    internalGate: "write",
    rules: agentRuntimeStore.getSession(sessionId).permissionRules,
    metadata: { source: "acp", acpKind: "edit", acpTitle: "Edit a file" },
  });
  expect(request.action).toBe("ask");
});

it("does not auto-approve a workspace executable masquerading as a read command on PATH", () => {
  const bin = path.join(directory, "workspace", "bin");
  fs.mkdirSync(bin);
  fs.writeFileSync(path.join(bin, "cat"), "#!/bin/sh\nexit 0", { mode: 0o755 });
  vi.stubEnv("PATH", bin + path.delimiter + process.env.PATH);
  const decision = permissionPolicy.evaluateShellCommand({
    sessionId,
    category: "shell",
    internalGate: "shell",
    command: "cat package.json",
    rules: agentRuntimeStore.getSession(sessionId).permissionRules,
  });
  expect(decision.action).toBe("ask");
  expect(decision.reason).toContain("workspace executable");
});
