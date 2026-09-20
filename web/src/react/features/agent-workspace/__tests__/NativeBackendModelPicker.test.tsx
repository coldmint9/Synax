import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NativeBackendModelPicker } from "../NativeBackendModelPicker";
import { PermissionApprovalBar } from "../PermissionApprovalBar";
import {
  agentRuntimeApi,
  type PermissionDecision,
} from "../../../../lib/api/agentRuntime";
vi.mock("../../../../hooks/useLocale", () => ({
  useLocale: () => ({ locale: "en", t: (key: string) => key }),
}));

describe("native backend controls", () => {
  it("loads backend-specific models and advertises their actual reasoning efforts", async () => {
    const models = vi
      .spyOn(agentRuntimeApi, "listBackendModels")
      .mockResolvedValue({
        defaultModel: "native-test",
        models: [
          { id: "native-test", label: "Native test", efforts: ["low", "high"] },
        ],
      });
    const efforts = vi.fn();
    render(
      <NativeBackendModelPicker
        backendId="codex"
        model="default"
        onChange={vi.fn()}
        onEffortsChange={efforts}
        disabled={false}
        nativeMetadata={{
          version: "0.test",
          sessionId: "native-id",
          cwd: "/tmp/work",
          model: "native-test",
        }}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "CLI model" }));
    await waitFor(() => expect(models).toHaveBeenCalledWith("codex"));
    await waitFor(() =>
      expect(efforts).toHaveBeenLastCalledWith(["low", "high"]),
    );
    expect(screen.getByText("Native session: native-id")).toBeInTheDocument();
    vi.restoreAllMocks();
  });
  it("uses the same one-shot restriction in the full permission bar as in the compact card", () => {
    const permission = {
      id: "native-permission",
      action: "ask",
      resolvedAt: null,
      patterns: ["native command"],
      reason: "Confirm operation",
      coarseCategory: "high_risk",
      metadata: { allowedReplies: ["once", "reject"] },
    } as PermissionDecision;
    render(
      <PermissionApprovalBar permissions={[permission]} onReply={vi.fn()} />,
    );
    expect(
      screen.queryByRole("button", { name: "permAlwaysAllow" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "permAllowOnce" }),
    ).toBeInTheDocument();
  });
});
