import { describe, expect, it, vi } from "vitest";
import { projectApi } from "../project";
import { teamApi } from "../team";

vi.mock("../project", () => ({ projectApi: { listProjects: vi.fn() } }));

describe("member project list", () => {
  it("never substitutes demo projects for an empty project list", async () => {
    vi.mocked(projectApi.listProjects).mockResolvedValue({
      items: [],
      total: 0,
    });
    expect(await teamApi.getMemberProjects("u-alice")).toEqual([]);
  });

  it("uses registered projects instead of a hardcoded example list", async () => {
    vi.mocked(projectApi.listProjects).mockResolvedValue({
      items: [
        {
          id: "real-project",
          name: "Desktop",
          status: "healthy",
          environment: "development",
          healthScore: 100,
          activeAgents: 0,
          activeHumans: 0,
          openRisks: 0,
          updatedAt: "2026-09-22",
        },
      ],
      total: 1,
    });
    expect(await teamApi.getMemberProjects("u-alice")).toEqual([
      { projectId: "real-project", name: "Desktop" },
    ]);
  });
});
