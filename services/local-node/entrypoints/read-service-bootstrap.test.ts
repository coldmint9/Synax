import { describe, expect, it } from "vitest";
import { profileService } from "../modules/agent-runtime/profile-service.js";
import { initializeReadServiceRuntime } from "./read-service-bootstrap.js";

describe("read service runtime bootstrap", () => {
  it("registers profiles required to serialize persisted sessions", () => {
    initializeReadServiceRuntime();
    expect(profileService.maybeGet("synax")).toBeDefined();
    expect(profileService.maybeGet("goal")).toBeDefined();
    expect(profileService.maybeGet("git-manager")).toBeDefined();
  });
});
