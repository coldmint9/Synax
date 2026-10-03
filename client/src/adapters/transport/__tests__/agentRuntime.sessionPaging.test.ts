import { expect, it, vi } from "vitest";
import { apiRequest } from "../origin";
import { agentRuntimeApi } from "../agentRuntime";
import { SESSION_PAGE_SIZE } from "../../../shared/lib/sessionListPaging";

vi.mock("../origin", () => ({ apiRequest: vi.fn(async () => ({ items: [] })), apiFetch: vi.fn() }));
it("requests search results in explicit pages of 20 with the supplied cursor", async () => {
  await agentRuntimeApi.searchSessions("workspace one", "长标题", 20);
  const url = new URL(vi.mocked(apiRequest).mock.calls[0][0], "http://localhost");
  expect(SESSION_PAGE_SIZE).toBe(20);
  expect(url.searchParams.get("limit")).toBe("20");
  expect(url.searchParams.get("offset")).toBe("20");
  expect(url.searchParams.get("q")).toBe("长标题");
});
