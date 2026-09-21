import { beforeEach, describe, expect, it, vi } from "vitest";
import { apiFetch, apiRequest } from "./origin";
import { artifactsApi } from "./artifacts";
vi.mock("./origin", () => ({ apiFetch: vi.fn(), apiRequest: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
describe("session-scoped artifact API", () => {
  it("encodes every path segment and uses confirmed feedback header", async () => {
    const input = { text: "Fix", idempotencyKey: "stable" };
    await artifactsApi.feedback("s/a", "r/b", input);
    expect(apiRequest).toHaveBeenCalledWith(
      "/api/agent-runtime/sessions/s%2Fa/artifacts/revisions/r%2Fb/feedback",
      expect.objectContaining({
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Synax-Artifact-Action": "confirm-feedback",
        },
        body: JSON.stringify(input),
      }),
    );
  });
  it("sends expectedEtag rather than silently overwriting newer state", async () => {
    await artifactsApi.saveState("s", "r", {
      privateState: null,
      modelState: { x: 1 },
      controls: { size: 2 },
      schemaVersion: 1,
      etag: 7,
    });
    expect(apiRequest).toHaveBeenCalledWith(
      expect.stringContaining("/revisions/r/state"),
      expect.objectContaining({
        method: "PUT",
        body: JSON.stringify({
          privateState: null,
          modelState: { x: 1 },
          controls: { size: 2 },
          schemaVersion: 1,
          expectedEtag: 7,
        }),
      }),
    );
  });
  it("downloads only through authenticated fetch, using an object URL", async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response("export"));
    const create = vi
      .spyOn(URL, "createObjectURL")
      .mockReturnValue("blob:authenticated-export");
    const click = vi
      .spyOn(HTMLAnchorElement.prototype, "click")
      .mockImplementation(() => {});
    await artifactsApi.download("session", "revision", "html");
    expect(apiFetch).toHaveBeenCalledWith(
      "/api/agent-runtime/sessions/session/artifacts/revisions/revision/export?format=html",
    );
    expect(create).toHaveBeenCalled();
    expect(click).toHaveBeenCalled();
    click.mockRestore();
    create.mockRestore();
  });
  it("does not open an unauthenticated endpoint on export error", async () => {
    vi.mocked(apiFetch).mockResolvedValue(new Response("", { status: 401 }));
    await expect(artifactsApi.download("s", "r", "source")).rejects.toThrow(
      "401",
    );
  });
});
