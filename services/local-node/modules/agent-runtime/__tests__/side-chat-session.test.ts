import { describe, expect, it } from "vitest";
import { sideChatSessionRequest } from "../../../../../client/src/features/agent-workspace/sideChatSession.js";
import type { AgentSession } from "../../../../../client/src/adapters/transport/agentRuntime.js";
import { createSessionRequestSchema } from "../contracts.js";
import { ProfileService } from "../profile-service.js";
import { synaxAgentProfile } from "../synax/synax-agent-profile.js";
import { validateBackendTurnInput } from "../backends/backend-binding.js";

const profiles = new ProfileService();
profiles.register(synaxAgentProfile);

function source(backendId = "native", profileId = "synax"): AgentSession {
  return {
    id: "source", projectId: "workspace", nodeId: null, profileId,
    status: "interrupted", model: null, reasoningEffort: "high",
    skillIds: ["review"], mcpServerIds: ["files"],
    sessionMetadata: {
      mode: "goal", goal: { objective: "Original task" },
      permissionTier: "auto", permissionOverrides: { shell: "ask", task: "deny" },
      backend: {
        id: backendId, model: "provider/model", workDir: "/workspace/feature",
        workspaceLocation: { kind: "host", path: "/workspace/feature" },
      },
    },
  } as AgentSession;
}

describe("side chat creation contract", () => {
  it.each(["synax", "goal", "subagent"])("starts a primary side chat from %s without child-session constraints", (profileId) => {
    const input = sideChatSessionRequest(source("native", profileId), "Side chat");
    const parsed = createSessionRequestSchema.parse(input);
    expect(parsed.parentSessionId).toBeUndefined();
    expect(profiles.assertCanStart(parsed.profileId, parsed).mode).toBe("primary");
    expect(() => validateBackendTurnInput(parsed.backendId ?? "native", parsed)).not.toThrow();
    expect(parsed).toMatchObject({
      profileId: "synax", workDir: "/workspace/feature", model: "provider/model", reasoningEffort: "high",
      permissionTier: "auto", permissionOverrides: { shell: "ask", task: "deny" },
      skillIds: ["review"], mcpServerIds: ["files"],
      sessionMetadata: {
        source: "session-page", mode: "chat", sideChatSourceSessionId: "source",
        workspaceLocation: { kind: "host", path: "/workspace/feature" },
      },
    });
    expect(parsed.sessionMetadata).not.toHaveProperty("goal");
    expect(parsed.sessionMetadata).not.toHaveProperty("parentSessionId");
  });

  it("omits Synax permission and tool overrides for a Codex backend", () => {
    const input = createSessionRequestSchema.parse(sideChatSessionRequest(source("codex"), "Side chat"));
    expect(() => validateBackendTurnInput("codex", input)).not.toThrow();
    expect(input.permissionTier).toBeUndefined();
    expect(input.permissionOverrides).toBeUndefined();
    expect(input.skillIds ?? []).toEqual([]);
    expect(input.mcpServerIds ?? []).toEqual([]);
    expect(profiles.assertCanStart(input.profileId, input).mode).toBe("primary");
  });

  it("keeps the subagent guard for actual child sessions", () => {
    expect(() => profiles.assertCanStart("synax", { parentSessionId: "source" }))
      .toThrow("Child sessions must use a subagent profile.");
    expect(profiles.assertCanStart("subagent", { parentSessionId: "source" }).mode).toBe("subagent");
  });
});
