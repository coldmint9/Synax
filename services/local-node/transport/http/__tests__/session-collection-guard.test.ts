import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { agentRuntimeRoutes } from "../agent-runtime.js";
import { runtimeFacade } from "../../../modules/agent-runtime/sidecar/runtime-facade.js";
import { RuntimeSidecarError } from "../../../modules/agent-runtime/sidecar/sidecar-client.js";
import { resetAgentRuntimeFixtures } from '../../../modules/agent-runtime/__tests__/agent-runtime-fixtures.js';

beforeEach(async () => {
  await resetAgentRuntimeFixtures();
});

afterEach(() => vi.restoreAllMocks());

const projectionMissing = async (): Promise<never> => {
  throw new RuntimeSidecarError({
    type: "error",
    code: "PROJECTION_MISSING",
    message: "session UI projection requires initialization",
  });
};

/**
 * The guard runs *after* a route that claims the path, so a spy installed here
 * still observes it. Any collection endpoint that the guard resolves as a
 * session answers `Agent runtime resource not found: <segment>`.
 */
const collectionEndpoints = [
  { url: "/sessions/search?projectId=p1&q=hello", method: "GET" },
  { url: "/sessions/badges?projectIds=p1", method: "GET" },
  {
    url: "/sessions/archive-inactive",
    method: "POST",
    body: { projectId: "p1" },
  },
  {
    url: "/sessions/clear-inactive",
    method: "POST",
    body: { projectId: "p1" },
  },
] as const;

for (const endpoint of collectionEndpoints) {
  it(`never resolves ${endpoint.url} as a session resource`, async () => {
    const guard = vi
      .spyOn(runtimeFacade, "uiSnapshotAuthoritative")
      .mockImplementation(projectionMissing);
    vi.spyOn(runtimeFacade, "listSessionProjection").mockResolvedValue([]);
    const response = await agentRuntimeRoutes.request(
      `http://localhost${endpoint.url}`,
      "body" in endpoint
        ? {
            method: endpoint.method,
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(endpoint.body),
          }
        : undefined,
    );
    expect(response.status).not.toBe(404);
    expect(guard).not.toHaveBeenCalled();
  });
}

it("reports a session without a durable registration as not found", async () => {
  vi.spyOn(runtimeFacade, "uiSnapshotAuthoritative").mockImplementation(
    projectionMissing,
  );
  vi.spyOn(runtimeFacade, "sessionExists").mockResolvedValue(false);
  const response = await agentRuntimeRoutes.request(
    "http://localhost/sessions/ars_missing/snapshot",
  );
  expect(response.status).toBe(404);
  expect(await response.json()).toMatchObject({
    code: "NOT_FOUND",
    error: "Agent runtime resource not found: ars_missing",
  });
});

it("reports a lost projection of an existing session as retryable, not missing", async () => {
  vi.spyOn(runtimeFacade, "uiSnapshotAuthoritative").mockImplementation(
    projectionMissing,
  );
  vi.spyOn(runtimeFacade, "sessionExists").mockResolvedValue(true);
  const response = await agentRuntimeRoutes.request(
    "http://localhost/sessions/ars_live/snapshot",
  );
  expect(response.status).toBe(503);
  expect(await response.json()).toMatchObject({ code: "PROJECTION_RECOVERING" });
});

it("keeps guarding session detail reads", async () => {
  const archived = {
    id: "ars_archived",
    status: "completed",
    sessionMetadata: { archivedAt: "2026-01-01" },
  };
  const guard = vi
    .spyOn(runtimeFacade, "uiSnapshotAuthoritative")
    .mockResolvedValue({ session: archived, run: null } as never);
  const response = await agentRuntimeRoutes.request(
    "http://localhost/sessions/ars_archived",
  );
  expect(guard).toHaveBeenCalledWith("ars_archived");
  expect(response.status).toBe(404);
});
