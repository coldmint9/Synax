import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { NativeBackendModelPicker } from "../NativeBackendModelPicker";
import { PermissionApprovalBar } from "../PermissionApprovalBar";
import {
  agentRuntimeApi,
  type PermissionDecision,
} from "../../../adapters/transport/agentRuntime";
vi.mock("../../../shared/hooks/useLocale", () => ({
  useLocale: () => ({ locale: "en", t: (key: string) => key }),
}));

afterEach(() => vi.restoreAllMocks());

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
    const permission: PermissionDecision = {
      sessionId: "s", runId: null, stepId: null, toolCallId: null, internalGate: "native", userReply: null, createdAt: "2026-09-27", resumeToken: null,
      id: "native-permission",
      action: "ask",
      resolvedAt: null,
      patterns: ["native command"],
      reason: "Confirm operation",
      coarseCategory: "high_risk",
      metadata: { allowedReplies: ["once", "reject"] },
    };
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

it("offers model search and custom IDs, selects with the keyboard and restores trigger focus", async () => {
  vi.spyOn(agentRuntimeApi, "listBackendModels").mockResolvedValue({ models: [{ id: "model-a", label: "Alpha", efforts: ["high"] }] });
  const user = userEvent.setup(), change = vi.fn(), overlay = vi.fn();
  render(<NativeBackendModelPicker backendId="codex" model="default" onChange={change} disabled={false} onOpenChange={overlay} />);
  const trigger = screen.getByRole("button", { name: "CLI model" });
  await user.click(trigger);
  const option = await screen.findByRole("option", { name: /Alpha/ });
  const input = screen.getByRole("combobox", { name: "Native model ID" });
  await user.clear(input);
  await user.type(input, "model-a");
  await user.keyboard("{ArrowDown}");
  await waitFor(() => expect(input).toHaveAttribute("aria-activedescendant", option.id));
  await user.keyboard("{Enter}");
  expect(change).toHaveBeenLastCalledWith("model-a");
  expect(trigger).toHaveFocus();
  expect(overlay).toHaveBeenLastCalledWith(false);
  await user.click(trigger);
  const custom = screen.getByRole("combobox");
  await user.clear(custom);
  await user.type(custom, "vendor/custom");
  await user.click(screen.getByRole("option", { name: "Use vendor/custom" }));
  expect(change).toHaveBeenLastCalledWith("vendor/custom");
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
});

it("keeps backend load errors readable and ignores a stale response from another backend", async () => {
  let finish!: (value: Awaited<ReturnType<typeof agentRuntimeApi.listBackendModels>>) => void;
  const load = vi.spyOn(agentRuntimeApi, "listBackendModels").mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; })).mockRejectedValueOnce(new Error("CLI missing")).mockResolvedValue({ defaultModel: "new", models: [{ id: "new", label: "New", efforts: ["low"] }] });
  const effort = vi.fn(), change = vi.fn(), user = userEvent.setup();
  const view = render(<NativeBackendModelPicker backendId="codex" model="default" onChange={change} disabled={false} onEffortsChange={effort} />);
  await user.click(screen.getByRole("button", { name: "CLI model" }));
  view.rerender(<NativeBackendModelPicker backendId="claude-code" model="default" onChange={change} disabled={false} onEffortsChange={effort} />);
  await user.click(screen.getByRole("button", { name: "CLI model" }));
  expect(await screen.findByRole("alert")).toHaveTextContent("CLI missing");
  await user.keyboard("{Escape}");
  await user.click(screen.getByRole("button", { name: "CLI model" }));
  await waitFor(() => expect(effort).toHaveBeenLastCalledWith(["low"]));
  await act(async () => finish({ defaultModel: "old", models: [{ id: "old", label: "Old", efforts: ["max"] }] }));
  expect(effort).toHaveBeenLastCalledWith(["low"]);
  expect(screen.queryByRole("option", { name: "Old" })).not.toBeInTheDocument();
  expect(load).toHaveBeenCalledTimes(3);
});
