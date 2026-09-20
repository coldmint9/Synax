import { beforeEach, describe, expect, it, vi } from "vitest";
import { providerMetricsApi } from "./providerMetrics";
import { apiFetch } from "./origin";

vi.mock("./origin", () => ({ apiFetch: vi.fn() }));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(apiFetch).mockResolvedValue(
    new Response(JSON.stringify({ fields: [] }), { status: 200 }),
  );
});

describe("providerMetricsApi contract", () => {
  it("only sends the strict server patch fields; field id already identifies the provider", async () => {
    await providerMetricsApi.update(
      "metric-id",
      { visible: true, accumulate: true },
      { providerId: "custom-api:kiro", sessionId: "session-id" },
    );
    expect(apiFetch).toHaveBeenCalledWith(
      "/api/config/provider-metrics",
      expect.objectContaining({
        method: "PATCH",
        body: JSON.stringify({
          id: "metric-id",
          visible: true,
          accumulate: true,
          sessionId: "session-id",
        }),
      }),
    );
  });

  it("encodes provider and session filters without mixing scope into the resource id", async () => {
    await providerMetricsApi.list({
      providerId: "custom-api:kiro",
      sessionId: "session/a",
    });
    expect(apiFetch).toHaveBeenCalledWith(
      "/api/config/provider-metrics?providerId=custom-api%3Akiro&sessionId=session%2Fa",
      expect.any(Object),
    );
  });
});
