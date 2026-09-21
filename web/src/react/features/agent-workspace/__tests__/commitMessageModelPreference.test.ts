import { describe, expect, it } from "vitest";
import { pickCommitMessageModel, useCommitModelPreference } from "../commitMessageModelPreference";
const models = [
  { kind: "api" as const, providerId: "p1", modelId: "m1", label: "M1" },
  { kind: "api" as const, providerId: "p2", modelId: "m2", label: "M2" },
];
describe("commit generation model selection", () => {
  it("keeps remembered choices separate for each project", () => {
    useCommitModelPreference.setState({ byProject: {} });
    useCommitModelPreference.getState().remember("project-a", "p2/m2");
    expect(useCommitModelPreference.getState().byProject).toEqual({ "project-a": "p2/m2" });
    expect(useCommitModelPreference.getState().byProject["project-b"]).toBeUndefined();
  });
  it("prefers remembered API model, then session model, then first configured API model", () => {
    expect(pickCommitMessageModel(models, "p1/m1", "p2/m2")).toEqual(models[1]);
    expect(pickCommitMessageModel(models, "p1/m1", "retired/nope")).toEqual(
      models[0],
    );
    expect(pickCommitMessageModel(models, "retired/nope", null)).toEqual(
      models[0],
    );
    expect(pickCommitMessageModel([], "p1/m1", null)).toBeNull();
  });
});
