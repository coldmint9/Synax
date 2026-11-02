import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeAsset } from "../../../adapters/transport/runtimeMedia";
import { runtimeMedia } from "../../../adapters/transport/runtimeMedia";
import { ToolCallSummaryLine } from "../ToolCallSummaryLine";
import { ToolCallMediaStrip } from "../ToolCallMediaStrip";
import { ConversationActivityGroup } from "../ConversationActivityGroup";
import type { ToolCallView } from "../buildInterleavedTurns";

vi.mock("../../../adapters/transport/runtimeMedia", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../../adapters/transport/runtimeMedia")>();
  return {
    ...original,
    runtimeMedia: {
      ...original.runtimeMedia,
      metadata: vi.fn(),
      blob: vi.fn(),
    },
  };
});

const ASSET_ID = "asset_00000000000000000000000000000000";
const asset: RuntimeAsset = {
  id: ASSET_ID,
  projectId: "project-1",
  filename: "chart.png",
  mediaType: "image/png",
  size: 2048,
  sha256: "hash",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function call(overrides: Partial<ToolCallView> = {}): ToolCallView {
  return {
    id: "call-1",
    toolId: "media.generate",
    inputSummary: '{"prompt":"a chart"}',
    outputSummary: "Generated 1 image",
    status: "completed",
    category: "task",
    duration: null,
    mutability: "task",
    contentParts: [{ type: "image", assetId: ASSET_ID }],
    ...overrides,
  };
}

describe("tool call images", () => {
  beforeEach(() => {
    vi.mocked(runtimeMedia.metadata).mockResolvedValue({ asset });
    vi.mocked(runtimeMedia.blob).mockResolvedValue(new Blob(["image"]));
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:chart"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
  });

  it("paints read and generated images on the call row without expanding it", async () => {
    render(<ToolCallSummaryLine call={call()} />);

    const thumb = await screen.findByRole("button", { name: "查看图片：chart.png" });
    expect(thumb).toBeInTheDocument();
    expect(screen.queryByText("Generated 1 image")).not.toBeInTheDocument();
  });

  it("opens the zoomable viewer from a thumbnail", async () => {
    render(<ToolCallSummaryLine call={call()} />);

    fireEvent.click(
      await screen.findByRole("button", { name: "查看图片：chart.png" }),
    );
    expect(screen.getByRole("dialog", { name: "chart.png" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "放大" }));
    expect(screen.getByRole("button", { name: "150%" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "关闭图片预览" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "chart.png" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("shows one thumbnail per asset across parallel calls", async () => {
    render(
      <ToolCallMediaStrip
        calls={[
          call(),
          call({ id: "call-2", toolId: "media.read", contentParts: [{ type: "image", assetId: ASSET_ID }] }),
        ]}
      />,
    );

    expect(
      await screen.findByRole("button", { name: "查看图片：chart.png" }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole("button", { name: "查看图片：chart.png" }),
    ).toHaveLength(1);
  });

  it("keeps a failed thumbnail visible as a retry instead of leaking an alert", async () => {
    vi.mocked(runtimeMedia.blob).mockRejectedValueOnce(new Error("Network error"));
    render(<ToolCallMediaStrip calls={[call()]} />);

    expect(
      await screen.findByRole("button", { name: "图片加载失败：chart.png" }),
    ).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows the picture under a folded process summary and once per open row", async () => {
    const { container } = render(
      <ConversationActivityGroup
        blocks={[{ type: "tool_call", call: call() }]}
        working={false}
        streaming={false}
      />,
    );

    expect(
      await screen.findByRole("button", { name: "查看图片：chart.png" }),
    ).toBeInTheDocument();

    fireEvent.click(container.querySelector(".session-process-trigger")!);
    await waitFor(() =>
      expect(
        screen.getAllByRole("button", { name: "查看图片：chart.png" }),
      ).toHaveLength(1),
    );
  });

  it("reserves the thumbnail strip height inside a virtualized live window", () => {
    const calls = Array.from({ length: 10 }, (_, index) =>
      call({
        id: `call-${index}`,
        contentParts:
          index === 0 ? [{ type: "image", assetId: ASSET_ID }] : undefined,
      }),
    );
    const { container } = render(
      <ConversationActivityGroup
        blocks={calls.map((item) => ({ type: "tool_call", call: item }))}
        working
        streaming={false}
      />,
    );

    expect(container.querySelector('[data-row-key="call:call-0"]')).toHaveStyle({
      height: "71px",
    });
    expect(container.querySelector('[data-row-key="call:call-1"]')).not.toHaveStyle({
      height: "71px",
    });
  });
});
