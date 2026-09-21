import { describe, expect, it, vi } from "vitest";
const mocks = vi.hoisted(() => ({ prepare: vi.fn(), stream: vi.fn() }));
vi.mock(
  "../../services/agent-runtime/session-commit-message-stream.js",
  () => ({
    prepareCommitMessageGeneration: mocks.prepare,
    streamSessionCommitMessage: mocks.stream,
  }),
);
import { agentRuntimeRoutes } from "../agent-runtime.js";
const request = (body: unknown) =>
  agentRuntimeRoutes.request(
    "http://localhost/sessions/s1/git/commit-message/stream",
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  );
describe("commit message stream route", () => {
  it("rejects a missing or blank commit message before committing", async () => {
    for (const body of [{}, { message: "   " }]) {
      const response = await agentRuntimeRoutes.request(
        "http://localhost/sessions/s1/git/commit",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        },
      );
      expect(response.status).toBe(400);
    }
  });
  it("requires a model before opening the stream", async () => {
    const response = await request({ rootId: "r1" });
    expect(response.status).toBe(400);
    expect(mocks.prepare).not.toHaveBeenCalled();
  });
  it("emits deltas, final and done for the selected model and root", async () => {
    mocks.prepare.mockResolvedValueOnce({ sessionId: "s1" });
    mocks.stream.mockImplementationOnce(async function* () {
      yield { type: "delta", text: "fix:" };
      yield { type: "final", message: "fix: change" };
    });
    const response = await request({ rootId: "r1", model: "p/m" });
    expect(response.status).toBe(200);
    expect(mocks.prepare).toHaveBeenCalledWith("s1", {
      rootId: "r1",
      model: "p/m",
    });
    const body = await response.text();
    expect(body).toContain('"type":"delta"');
    expect(body).toContain('"type":"final"');
    expect(body).toContain("[DONE]");
  });
  it("reports generation errors in the SSE stream", async () => {
    mocks.prepare.mockResolvedValueOnce({ sessionId: "s1" });
    mocks.stream.mockImplementationOnce(async function* () {
      throw new Error("model unavailable");
    });
    const response = await request({ model: "p/m" });
    expect(await response.text()).toContain("model unavailable");
  });
});
