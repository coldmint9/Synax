import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { agentSessionRuntime } from "../session-runtime.js";
import {
  clearSessionWorkspaceRoot,
  setSessionWorkspaceRoot,
} from "../tools/workspace.js";
import {
  readDesign,
  transitionDesign,
  writeDesign,
} from "../design-service.js";
import { resetAgentRuntimeFixtures } from "./agent-runtime-fixtures.js";

let workspace = "";
let sessionId = "";

beforeEach(() => {
  resetAgentRuntimeFixtures();
  workspace = fs.mkdtempSync(path.join(os.tmpdir(), "Synax-design-"));
  const session = agentSessionRuntime.create({
    projectId: "project-alpha",
    profileId: "planner",
    prompt: "Design test",
  });
  sessionId = session.id;
  setSessionWorkspaceRoot(sessionId, workspace);
});

afterEach(() => {
  clearSessionWorkspaceRoot(sessionId);
  fs.rmSync(workspace, { recursive: true, force: true });
});

describe("design service", () => {
  it("reads an empty draft and atomically persists revisions", () => {
    expect(readDesign(sessionId)).toMatchObject({
      content: "",
      revision: 0,
      status: "draft",
      relativePath: `.synax/designs/${sessionId}/design.md`,
    });

    const saved = writeDesign(sessionId, "# Design\n\n## Goal\nShip it\n");
    expect(saved).toMatchObject({ revision: 1, status: "draft" });
    expect(
      fs.readFileSync(path.join(workspace, saved.relativePath), "utf8"),
    ).toContain("# Design");
  });

  it("rejects stale writes without replacing the current draft", () => {
    writeDesign(sessionId, "v1");
    expect(() => writeDesign(sessionId, "v2", 0)).toThrow(
      /revision changed/,
    );
    expect(readDesign(sessionId).content).toBe("v1");
  });

  it("allows informational status jumps and reversions", () => {
    writeDesign(sessionId, "draft");
    expect(transitionDesign(sessionId, "approved").status).toBe("approved");
    expect(transitionDesign(sessionId, "draft").status).toBe("draft");
  });

  it("keeps the design path inside the session workspace", () => {
    const snapshot = writeDesign(sessionId, "safe");
    expect(snapshot.relativePath.startsWith(".synax/")).toBe(true);
    expect(path.resolve(workspace, snapshot.relativePath)).toContain(workspace);
  });
});
