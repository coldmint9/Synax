import { afterEach, describe, expect, it } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import type { AgentSession } from "../../../adapters/transport/agentRuntime";
import { SubagentIdentity, SubagentProfileCard } from "../SubagentIdentity";

afterEach(cleanup);
const session = {
  id: "child", profileId: "reviewer", status: "running",
  sessionMetadata: { subagentName: "程野", roleName: "审查员", roleDescription: "检查实现并给出意见。" },
} as AgentSession;

describe("SubagentIdentity", () => {
  it("renders one identity in the readonly detail and only the description beneath", () => {
    render(<><SubagentIdentity session={session} /><SubagentProfileCard session={session} showIdentity={false} /></>);
    expect(screen.getAllByText("程野")).toHaveLength(1);
    expect(screen.getAllByText("审查员")).toHaveLength(1);
    expect(screen.getByText("检查实现并给出意见。")).toBeTruthy();
  });
});
