import { it, expect } from "vitest";
import { artifactSdkSource } from "../../../../../../api/services/agent-runtime/artifacts/runtime-sdk";
it("ships only a minimal theme/size/ready contract, with bound identity and no privileged SDK operations", () => {
  const source = artifactSdkSource();
  expect(source).toContain("prototypeId");
  expect(source).toContain("event.source!==parent");
  expect(source).toContain("event.source!==window");
  for (const name of [
    "setState",
    "getState",
    "registerControls",
    "requestFeedbackDraft",
    "annotationClear",
    "pick",
  ])
    expect(source).not.toContain(name);
});
