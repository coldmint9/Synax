import { describe, expect, it, vi } from "vitest";
vi.mock("../../services/agent-runtime/session-search.js", () => ({
  searchSessions: vi.fn(() => ({ items: [], hasMore: false })),
}));
import { agentRuntimeRoutes } from "../agent-runtime.js";
import { searchSessions } from "../../services/agent-runtime/session-search.js";

describe("session search endpoint", () => {
  it.each([
    "q=hello",
    "projectId=alpha&q=",
    "projectId=alpha&q=hello&offset=-1",
    "projectId=alpha&q=hello&limit=999",
  ])("validates scope and paging: %s", async (query) => {
    expect(
      (
        await agentRuntimeRoutes.request(
          `http://localhost/sessions/search?${query}`,
        )
      ).status,
    ).toBe(400);
  });
  it("dispatches scoped search before the session-id route", async () => {
    const response = await agentRuntimeRoutes.request(
      "http://localhost/sessions/search?projectId=alpha&q=hello&offset=50",
    );
    expect(response.status).toBe(200);
    expect(searchSessions).toHaveBeenCalledWith("alpha", "hello", 50, 50);
    expect(await response.json()).toEqual({ items: [], hasMore: false });
  });
});
