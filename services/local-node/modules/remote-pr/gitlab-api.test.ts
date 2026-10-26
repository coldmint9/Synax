import { afterEach, beforeEach, expect, it, vi } from "vitest";
vi.mock("../../infrastructure/runtime/config/config-store.js", () => ({
  getGitLabTokenForHost: vi.fn(),
}));
vi.mock("../agent-runtime/tools/exec-async.js", () => ({
  runCommand: vi.fn(),
}));
import { getGitLabTokenForHost } from "../../infrastructure/runtime/config/config-store.js";
import { runCommand } from "../agent-runtime/tools/exec-async.js";
import {
  gitLabHost,
  gitLabRequest,
  validateGitLabAccount,
} from "./gitlab-api.js";
import { RemotePrProvider } from "./provider.js";

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", fetchMock);
  vi.mocked(getGitLabTokenForHost).mockImplementation((host) =>
    host === "gitlab.example.com" ? "private-test-token" : undefined,
  );
});
afterEach(() => vi.unstubAllGlobals());

it("uses the built-in API for GitLab with host-scoped authentication and no CLI", async () => {
  fetchMock.mockResolvedValue(Response.json([]));
  const repo = {
    provider: "gitlab" as const,
    host: "gitlab.example.com",
    remote: "origin",
    path: "group/sub/app",
  };
  expect(await new RemotePrProvider().list(repo)).toEqual({
    items: [],
    hasMore: false,
  });
  expect(String(fetchMock.mock.calls[0][0])).toBe(
    "https://gitlab.example.com/api/v4/projects/group%2Fsub%2Fapp/merge_requests?state=opened&per_page=30&page=1&order_by=updated_at&sort=desc",
  );
  expect(fetchMock.mock.calls[0][1]).toMatchObject({
    method: "GET",
    redirect: "error",
    headers: { "PRIVATE-TOKEN": "private-test-token" },
  });
  expect(runCommand).not.toHaveBeenCalled();
});

it("posts JSON without putting tokens in URLs and validates only safe account fields", async () => {
  fetchMock.mockResolvedValue(
    Response.json({
      id: 1,
      username: "mint",
      name: "Mint",
      private_token: "do-not-return",
    }),
  );
  expect(await validateGitLabAccount("GITLAB.COM:443", "new-token")).toEqual({
    host: "gitlab.com",
    username: "mint",
    name: "Mint",
  });
  await gitLabRequest(
    "gitlab.example.com",
    "POST",
    "projects/g%2Fp/merge_requests",
    { title: "line\n`$title`" },
  );
  expect(fetchMock.mock.calls[1][1]?.body).toBe(
    JSON.stringify({ title: "line\n`$title`" }),
  );
  expect(String(fetchMock.mock.calls[1][0])).not.toContain(
    "private-test-token",
  );
});

it("does not send another host’s token and never follows an endpoint outside the API", async () => {
  await expect(
    gitLabRequest("other.example.com", "GET", "user"),
  ).rejects.toMatchObject({ code: "PR_AUTH_REQUIRED" });
  for (const endpoint of [
    "https://evil.example/user",
    "//evil.example/user",
    "../user",
    "/oauth/token",
  ]) {
    await expect(
      gitLabRequest("gitlab.example.com", "GET", endpoint),
    ).rejects.toMatchObject({ code: "INVALID_ENDPOINT" });
  }
  expect(fetchMock).not.toHaveBeenCalled();
});

it.each([
  [401, "PR_AUTH_REQUIRED"],
  [403, "PR_AUTH_REQUIRED"],
  [404, "PR_NOT_FOUND"],
  [409, "PR_REMOTE_CONFLICT"],
  [422, "PR_REMOTE_CONFLICT"],
  [429, "PR_RATE_LIMITED"],
  [500, "PR_REQUEST_FAILED"],
])(
  "maps HTTP %s without exposing server response text",
  async (status, code) => {
    fetchMock.mockImplementation(
      async () =>
        new Response("secret=private-test-token", { status: Number(status) }),
    );
    await expect(
      gitLabRequest("gitlab.example.com", "GET", "user"),
    ).rejects.toMatchObject({ code });
    await expect(
      gitLabRequest("gitlab.example.com", "GET", "user"),
    ).rejects.not.toThrow(/secret=|private-test-token/);
  },
);

it("bounds the response and sanitizes transport, redirect and JSON failures", async () => {
  fetchMock.mockRejectedValueOnce(
    new Error("redirect failed secret=private-test-token"),
  );
  await expect(
    gitLabRequest("gitlab.example.com", "GET", "user"),
  ).rejects.toMatchObject({ code: "PR_REQUEST_FAILED" });
  fetchMock.mockResolvedValueOnce(new Response("not json"));
  await expect(
    gitLabRequest("gitlab.example.com", "GET", "user"),
  ).rejects.toMatchObject({ code: "PR_INVALID_RESPONSE" });
  fetchMock.mockResolvedValueOnce(
    new Response("x".repeat(4 * 1024 * 1024 + 1)),
  );
  await expect(
    gitLabRequest("gitlab.example.com", "GET", "user"),
  ).rejects.toMatchObject({ code: "PR_INVALID_RESPONSE" });
});

it.each([
  "http://example.com",
  "example.com/path",
  "user@example.com",
  "example.com:99999",
  ".example.com",
])("rejects invalid host %s", (host) => {
  expect(() => gitLabHost(host)).toThrow();
});
