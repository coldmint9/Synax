import { beforeEach, expect, it, vi } from "vitest";
import { apiRequest } from "./origin";
import { artifactVersionsApi } from "./artifactVersions";
vi.mock("./origin", () => ({ apiRequest: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
it("encodes session/revision segments, pins fork source and marks explicit publication", async () => {
  const input = { title: "Branch", idempotencyKey: "stable-key" };
  await artifactVersionsApi.fork("s/a", "r/b", input);
  expect(apiRequest).toHaveBeenCalledWith(
    "/api/agent-runtime/sessions/s%2Fa/artifacts/revisions/r%2Fb/fork",
    expect.objectContaining({
      method: "POST",
      body: JSON.stringify(input),
      headers: expect.objectContaining({
        "X-Synax-Artifact-Action": "confirm-fork",
      }),
    }),
  );
});
it("registers durable schema through the host-only header", async () => {
  const input = { schemaVersion: 1, controls: [] };
  await artifactVersionsApi.registerControlSchema("s", "r", input);
  expect(apiRequest).toHaveBeenCalledWith(
    expect.stringContaining("/r/control-schema"),
    expect.objectContaining({
      method: "PUT",
      body: JSON.stringify(input),
      headers: expect.objectContaining({
        "X-Synax-Artifact-Action": "register-control-schema",
      }),
    }),
  );
});
it("sends both source/target CAS and sensitive confirmation without serializing state contents", async () => {
  const input = {
    sourceRevisionId: "source",
    sourceEtag: 4,
    expectedEtag: 2,
    includePrivateState: false,
    includeModelState: false,
    confirmSensitiveState: false,
  };
  await artifactVersionsApi.inheritState("s", "target", input);
  expect(apiRequest).toHaveBeenCalledWith(
    expect.stringContaining("/target/inherit-state"),
    expect.objectContaining({
      body: JSON.stringify(input),
      headers: expect.objectContaining({
        "X-Synax-Artifact-Action": "confirm-inherit-state",
      }),
    }),
  );
  await artifactVersionsApi.inspectInheritance("s", "target", "r&evil");
  expect(apiRequest).toHaveBeenLastCalledWith(
    expect.stringContaining("?sourceRevisionId=r%26evil"),
    { silent: true },
  );
});
it("returns the authoritative schema version and CAS etag after virgin-state initialization", async () => {
  const schema = { schemaVersion: 2, controls: [] };
  const state = {
    schemaVersion: 2,
    controls: {},
    etag: 1,
    privateState: null,
    modelState: null,
  };
  vi.mocked(apiRequest).mockResolvedValueOnce({ schema, state });
  expect(
    await artifactVersionsApi.registerControlSchema("s", "r", schema),
  ).toEqual({ schema, state });
  expect(apiRequest).toHaveBeenCalledWith(
    expect.stringContaining("/r/control-schema"),
    expect.objectContaining({ body: JSON.stringify(schema) }),
  );
});
