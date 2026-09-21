import { it, expect, vi, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { ArtifactPublicationCard } from "../ArtifactPublicationCard";
import { apiRequest } from "../../../../lib/api/origin";
vi.mock("../../../../lib/api/origin", () => ({ apiRequest: vi.fn() }));
vi.mock("../../../../hooks/useLocale", () => ({
  useLocale: () => ({ locale: "zh" }),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it("reads a pending request, then only publishes after explicit host approval", async () => {
  vi.mocked(apiRequest)
    .mockResolvedValueOnce({ status: "pending" })
    .mockResolvedValueOnce({ status: "ready" });
  render(
    <ArtifactPublicationCard
      sessionId="s"
      reference={{ requestId: "p", title: "Demo", sourcePath: "demo.html" }}
    />,
  );
  const approve = await screen.findByRole("button", { name: "批准并发布" });
  expect(apiRequest).toHaveBeenCalledTimes(1);
  fireEvent.click(approve);
  await waitFor(() =>
    expect(screen.getByText("已批准并发布，预览在下方会话中。")).toBeVisible(),
  );
  expect(apiRequest).toHaveBeenLastCalledWith(
    expect.stringContaining("/requests/p"),
    expect.objectContaining({
      method: "POST",
      headers: expect.objectContaining({
        "X-Synax-Artifact-Action": "confirm-publication",
      }),
    }),
  );
});
