import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { GlobalConfig } from "../../../../shared/contracts/config";
import type { SuperCodingConfig } from "../../../../../packages/contracts/super-coding";
import { SuperModelPoolSection } from "./SuperModelPoolSection";

function config(
  superCoding: Partial<SuperCodingConfig> = {},
): GlobalConfig {
  return {
    version: 1,
    providers: [
      {
        id: "anthropic",
        label: "Anthropic",
        status: "live",
        kind: "api",
        caps: { canFollowUp: true, canCancel: true },
        models: [
          { id: "claude-opus-4.5", label: "Opus 4.5" },
          { id: "claude-sonnet-4.5", label: "Sonnet 4.5" },
        ],
      },
    ],
    defaultProviderId: "anthropic",
    defaultApiProviderId: "anthropic",
    providerConnections: {},
    mcpServers: [],
    webSearch: { enabled: false } as GlobalConfig["webSearch"],
    limits: { maxAgentsPerProject: 3, agentTimeoutMs: 600000 },
    features: { allowProjectConnectionOverride: false },
    updatedAt: "2026-10-29T00:00:00.000Z",
    updatedBy: "test",
    superCoding: {
      models: [
        {
          id: "anthropic/claude-opus-4.5",
          label: "Anthropic · Opus 4.5",
          enabled: true,
          tags: ["deep-reasoning"],
        },
      ],
      routes: [],
      defaultModel: "",
      maxNodes: 8,
      maxConcurrent: 5,
      ...superCoding,
    },
  };
}

describe("SuperModelPoolSection", () => {
  it("shows the configured pool and tags", () => {
    render(<SuperModelPoolSection config={config()} onUpdate={vi.fn()} />);
    expect(screen.getAllByText("Anthropic · Opus 4.5").length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: "深度推理" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("adds an available provider model to the pool", () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    render(<SuperModelPoolSection config={config()} onUpdate={onUpdate} />);
    fireEvent.change(screen.getByLabelText("添加模型"), {
      target: { value: "anthropic/claude-sonnet-4.5" },
    });
    expect(screen.getAllByText(/claude-sonnet-4.5/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(onUpdate).toHaveBeenCalledTimes(1);
    const patch = onUpdate.mock.calls[0][0] as { superCoding: { models: unknown[] } };
    expect(patch.superCoding.models).toHaveLength(2);
  });

  it("refuses to save when every model is disabled", () => {
    render(<SuperModelPoolSection config={config()} onUpdate={vi.fn()} />);
    fireEvent.click(screen.getByRole("switch", { name: /启用|停用/ }));
    expect(
      (screen.getByRole("button", { name: "保存" }) as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  it("saves an empty pool as follow the session model", async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    render(
      <SuperModelPoolSection
        config={config({ models: [] })}
        onUpdate={onUpdate}
      />,
    );
    expect(
      screen.getByText("未配置模型池：子代理跟随主会话模型。"),
    ).toBeTruthy();
    const save = screen.getByRole("button", { name: "保存" }) as HTMLButtonElement;
    expect(save.disabled).toBe(false);

    fireEvent.click(save);
    await waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
    const patch = onUpdate.mock.calls[0][0] as {
      superCoding: { models: unknown[] };
    };
    expect(patch.superCoding.models).toEqual([]);
  });

  it("writes routes and budgets into the saved config", async () => {
    const onUpdate = vi.fn().mockResolvedValue(undefined);
    render(<SuperModelPoolSection config={config()} onUpdate={onUpdate} />);
    fireEvent.change(screen.getByLabelText("实现"), {
      target: { value: "anthropic/claude-opus-4.5" },
    });
    fireEvent.change(screen.getByLabelText("节点上限"), { target: { value: "10" } });
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    await waitFor(() => expect(onUpdate).toHaveBeenCalled());
    const patch = onUpdate.mock.calls[0][0] as {
      superCoding: { routes: Array<{ taskTypes: string[]; model: string }>; maxNodes: number };
    };
    expect(patch.superCoding.maxNodes).toBe(10);
    expect(patch.superCoding.routes).toContainEqual({
      taskTypes: ["implement"],
      model: "anthropic/claude-opus-4.5",
    });
  });

  it("surfaces a save failure instead of claiming success", async () => {
    const onUpdate = vi.fn().mockRejectedValue(new Error("config rejected"));
    render(<SuperModelPoolSection config={config()} onUpdate={onUpdate} />);
    fireEvent.click(screen.getByRole("button", { name: "保存" }));
    expect(await screen.findByRole("alert")).toHaveProperty(
      "textContent",
      "config rejected",
    );
    expect(screen.queryByText("已保存")).toBeNull();
  });
});
