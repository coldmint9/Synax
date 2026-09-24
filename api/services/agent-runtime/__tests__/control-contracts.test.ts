import { describe, expect, it } from "vitest";
import { humanQuestionSchema } from "../control-contracts.js";

describe("human question recommendations", () => {
  const options = [
    { value: "fast", label: "Fast" },
    { value: "safe", label: "Safe" },
  ];

  it("accepts recommendations that match select options", () => {
    expect(
      humanQuestionSchema.safeParse({
        id: "mode",
        type: "multi_select",
        label: "Modes",
        options,
        recommended: ["fast", "safe"],
      }).success,
    ).toBe(true);
  });

  it.each([
    {
      type: "text",
      options: undefined,
      recommended: ["fast"],
    },
    {
      type: "single_select",
      options,
      recommended: ["fast", "safe"],
    },
    {
      type: "single_select",
      options,
      recommended: ["missing"],
    },
  ])("rejects invalid recommendations", (question) => {
    expect(
      humanQuestionSchema.safeParse({
        id: "mode",
        label: "Mode",
        ...question,
      }).success,
    ).toBe(false);
  });
});
