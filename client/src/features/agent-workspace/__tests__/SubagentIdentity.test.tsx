import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { AgentSession } from "../../../adapters/transport/agentRuntime";
import { getSubagentNameFromId, SubagentIdentity, SubagentProfileCard } from "../SubagentIdentity";

afterEach(cleanup);
const session = {
  id: "child", profileId: "reviewer", status: "running",
  sessionMetadata: { subagentName: "程野", roleName: "审查员", roleDescription: "检查实现并给出意见。" },
} as AgentSession;

describe("SubagentIdentity", () => {
  it.each(["小土豆 🥔", "Cloud 9", "42", "🦆"])("renders the supplied name %s", (name) => {
    render(<SubagentIdentity session={{ ...session, sessionMetadata: { ...session.sessionMetadata, subagentName: name } }} />);
    expect(screen.getByText(name)).toBeTruthy();
  });

  it("uses a neutral session identifier when a historical name is missing", () => {
    expect(getSubagentNameFromId("abcdefgh-1234")).toBe("子代理 abcdefgh");
    expect(getSubagentNameFromId("abcdefgh-1234", "  ")).toBe("子代理 abcdefgh");
    expect(getSubagentNameFromId("abcdefgh-1234", "  程野  ")).toBe("程野");
  });

  it("renders one identity in the readonly detail and only the description beneath", () => {
    render(<><SubagentIdentity session={session} /><SubagentProfileCard session={session} showIdentity={false} /></>);
    expect(screen.getAllByText("程野")).toHaveLength(1);
    expect(screen.getAllByText("审查员")).toHaveLength(1);
    expect(screen.getByText("检查实现并给出意见。")).toBeTruthy();
  });
});
