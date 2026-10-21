import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { RuntimeRecoveryPanel } from "../RuntimeRecoveryPanel";
import type { AgentSession } from "../../../adapters/transport/agentRuntime";
vi.mock("../../../shared/hooks/useLocale", () => ({
  useLocale: () => ({ locale: "en" }),
}));

describe("stale execution notice", () => {
  it("explains an unsettled stop without asking the user to retry cleanup", () => {
    const session = {
      id: "recovery",
      sessionMetadata: {
        runtimeControl: { state: "unconfirmed", reason: "Review changes." },
      },
    } as AgentSession;
    render(<RuntimeRecoveryPanel session={session} />);
    expect(screen.getByText("Previous execution was interrupted")).toBeVisible();
    expect(screen.getByText("Review changes.")).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  it("renders nothing for a settled session", () => {
    const session = { id: "idle", sessionMetadata: {} } as AgentSession;
    const { container } = render(<RuntimeRecoveryPanel session={session} />);
    expect(container).toBeEmptyDOMElement();
  });
});
