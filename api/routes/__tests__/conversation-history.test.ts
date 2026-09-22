import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentRuntimeRoutes } from "../agent-runtime.js";
import {
  resetAgentRuntimeFixtures,
  plannerSessionInput,
} from "../../services/agent-runtime/__tests__/agent-runtime-fixtures.js";
import { agentSessionRuntime } from "../../services/agent-runtime/session-runtime.js";
import { agentRuntimeStore as store } from "../../services/agent-runtime/session-store.js";
import { captureCheckpoint } from "../../services/agent-runtime/checkpoints/store.js";
import { withCheckpointMutation as recordFileChange } from "../../services/agent-runtime/checkpoints/mutations.js";
const withCheckpointMutation = <T>(
  session: string,
  action: () => Promise<T> | T,
) =>
  recordFileChange(
    session,
    action,
    false,
    ["file", "new", "created", "a", "b"].map((name) => path.join(root, name)),
  );
let root: string, id: string, checkpointId: string;
beforeEach(async () => {
  resetAgentRuntimeFixtures();
  root = await fs.mkdtemp(path.join(os.tmpdir(), "synax-history-route-"));
  id = agentSessionRuntime.create({ ...plannerSessionInput, workDir: root }).id;
  store.updateSession(id, { status: "completed" });
  await fs.writeFile(path.join(root, "file"), "before");
  store.appendMessage({
    id: "reply",
    sessionId: id,
    role: "assistant",
    content: "done",
    runId: null,
    stepId: null,
    metadata: {},
    createdAt: new Date().toISOString(),
  });
  checkpointId = (await captureCheckpoint(id, "reply", "reply"))!.id;
});
afterEach(async () => {
  await fs.rm(root, { recursive: true, force: true });
});
const post = (route: string, body: unknown) =>
  agentRuntimeRoutes.request(`/sessions/${id}/history/${route}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
describe("conversation history API", () => {
  it("lists stable message identities, previews without mutation, and applies an idempotent rollback", async () => {
    const summary = await (
      await agentRuntimeRoutes.request(`/sessions/${id}/checkpoints`)
    ).json();
    expect(summary.checkpoints[0]).toMatchObject({
      id: checkpointId,
      messageId: "reply",
      kind: "reply",
      available: true,
    });
    await withCheckpointMutation(id, () =>
      fs.writeFile(path.join(root, "file"), "after"),
    );
    const preview = await post("preview", { checkpointId, action: "rollback" });
    expect(preview.status).toBe(200);
    expect((await preview.json()).files).toHaveLength(1);
    expect(await fs.readFile(path.join(root, "file"), "utf8")).toBe("after");
    const body = { checkpointId, revision: 0, requestId: "api-rollback" };
    const response = await post("rollback", body);
    expect(response.status).toBe(200);
    expect(await fs.readFile(path.join(root, "file"), "utf8")).toBe("before");
    expect(await (await post("rollback", body)).json()).toEqual(
      await response.json(),
    );
  });
  it("validates revision and checkpoint ownership before changing files", async () => {
    expect(
      (await post("rollback", { checkpointId, revision: -1, requestId: "bad" }))
        .status,
    ).toBe(400);
    expect(
      (
        await post("rollback", {
          checkpointId: "another-session-checkpoint",
          revision: 0,
          requestId: "missing",
        })
      ).status,
    ).toBe(409);
    expect(
      (
        await post("rollback", {
          checkpointId,
          revision: 4,
          requestId: "stale",
        })
      ).status,
    ).toBe(409);
    expect(await fs.readFile(path.join(root, "file"), "utf8")).toBe("before");
  });
});
