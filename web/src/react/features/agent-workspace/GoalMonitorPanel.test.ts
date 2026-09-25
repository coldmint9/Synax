import { describe, expect, it } from "vitest";
import { statusFor } from "./GoalMonitorPanel";

describe("goal monitor status", () => {
  it("shows paused for an executing goal after its run is interrupted", () => {
    expect(
      statusFor({ status: "interrupted" }, { status: "executing" }, false),
    ).toBe("paused");
  });

  it("shows completed only when acceptance evidence exists", () => {
    expect(
      statusFor(
        { status: "completed" },
        { status: "completed", acceptanceEvidence: [{}] },
        false,
      ),
    ).toBe("completed");
    expect(
      statusFor({ status: "completed" }, { status: "completed" }, false),
    ).toBe("planning");
  });
});
