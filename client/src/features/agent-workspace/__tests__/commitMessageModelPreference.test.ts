import { describe, expect, it } from "vitest";
import { pickCommitMessageModel, useCommitModelPreference } from "../commitMessageModelPreference";
const models = [
  { kind: "api" as const, providerId: "p1", modelId: "m1", label: "M1" },
  { kind: "api" as const, providerId: "p2", modelId: "m2", label: "M2" },
];
const capabilityModels = [
  {
    kind: "api" as const,
    providerId: "p1",
    modelId: "paint-1",
    label: "Paint",
    capability: "image_generation" as const,
  },
  {
    kind: "api" as const,
    providerId: "p1",
    modelId: "chat-1",
    label: "Chat",
    capability: "chat" as const,
  },
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
  it("never generates a commit message with a non-chat capability", () => {
    // A model is listed once per capability; an image entry must not win.
    expect(pickCommitMessageModel(capabilityModels, "p1/paint-1", null)).toEqual(
      capabilityModels[1],
    );
    expect(pickCommitMessageModel(capabilityModels, "retired/nope", null)).toEqual(
      capabilityModels[1],
    );
  });
});
