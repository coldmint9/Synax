import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ProjectToolGrantsSection } from "./ProjectToolGrantsSection";

const api = vi.hoisted(() => ({
  list: vi.fn(),
  revoke: vi.fn(),
}));
vi.mock("../../../../hooks/useLocale", () => ({
  useLocale: () => ({ locale: "zh" }),
}));
vi.mock("../../../../lib/api/agentRuntime", () => ({
  agentRuntimeApi: {
    listProjectToolGrants: api.list,
    revokeProjectToolGrant: api.revoke,
  },
}));

describe("project-wide tool grants", () => {
  it("shows each tool and revokes within the current project", async () => {
    api.list.mockResolvedValueOnce({ items: [{ projectId: "p1", toolId: "bash", permissionId: "pd1", createdAt: "now" }] })
      .mockResolvedValueOnce({ items: [] });
    api.revoke.mockResolvedValue({ revoked: true });
    render(<ProjectToolGrantsSection projectId="p1" />);
    expect(await screen.findByText("bash")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "撤销 bash" }));
    expect(api.revoke).toHaveBeenCalledWith("p1", "bash");
    await waitFor(() => expect(screen.getByText("暂无项目级工具授权。")).toBeInTheDocument());
  });
});
