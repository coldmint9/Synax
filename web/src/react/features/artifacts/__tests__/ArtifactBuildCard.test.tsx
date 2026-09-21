import { afterEach, it, expect, vi } from "vitest";
import { cleanup, render, screen, fireEvent } from "@testing-library/react";
import { ArtifactBuildCard } from "../ArtifactBuildCard";
import { apiRequest } from "../../../../lib/api/origin";
vi.mock("../../../../lib/api/origin", () => ({ apiRequest: vi.fn() }));
vi.mock("../../../../hooks/useLocale", () => ({
  useLocale: () => ({ locale: "zh" }),
}));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
it("shows durable build status and cancels only on host action", async () => {
  const job = {
    jobId: "j",
    title: "Prototype",
    status: "building",
    diagnostics: [],
  };
  vi.mocked(apiRequest)
    .mockResolvedValueOnce({ job })
    .mockResolvedValue({ job: { ...job, status: "cancelled" } });
  render(
    <ArtifactBuildCard
      sessionId="s"
      reference={{ jobId: "j", title: "Prototype" }}
    />,
  );
  fireEvent.click(await screen.findByRole("button", { name: "取消构建" }));
  expect(await screen.findByRole("button", { name: "重试构建" })).toBeVisible();
  expect(apiRequest).toHaveBeenCalledWith(
    expect.stringContaining("/jobs/j/cancel"),
    expect.objectContaining({ method: "POST" }),
  );
});
