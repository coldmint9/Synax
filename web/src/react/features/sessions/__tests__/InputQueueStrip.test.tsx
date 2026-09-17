import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { QueuedInput } from "../../../../lib/api/agentRuntime";
import { runtimeMedia } from "../../../../lib/api/runtimeMedia";
import { InputQueueStrip } from "../InputQueueStrip";

vi.mock("../../../../lib/api/runtimeMedia", async (importOriginal) => {
  const original = await importOriginal<
    typeof import("../../../../lib/api/runtimeMedia")
  >();
  return {
    ...original,
    runtimeMedia: {
      ...original.runtimeMedia,
      blob: vi.fn(),
    },
  };
});

function queuedItem(overrides: Partial<QueuedInput>): QueuedInput {
  return {
    id: "q-1",
    message: "help me with this screenshot",
    model: null,
    enqueuedAt: "2026-09-17T00:00:00.000Z",
    ...overrides,
  };
}

function queuedInputItem(): QueuedInput {
  return {
    ...queuedItem({}),
    id: "q-1",
    message: "help me with this screenshot",
    contentParts: [
      { type: "text", text: "help me with this screenshot" },
      { type: "image", assetId: "asset_a" },
      { type: "file", assetId: "asset_b" },
    ],
  };
}

describe("InputQueueStrip media rendering", () => {
  it("renders compact image thumbnails instead of full media cards", async () => {
    vi.mocked(runtimeMedia.blob).mockResolvedValue(new Blob(["img"]));
    const { container } = render(
      <InputQueueStrip
        items={[queuedInputItem()]}
        onRemove={vi.fn()}
        onForce={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(container.querySelectorAll("img.queue-media-thumb")).toHaveLength(
        1,
      );
    });
    // Full MediaParts card markup must never appear inside the pill.
    expect(container.querySelector(".rounded-xl.border")).toBeNull();
    expect(screen.queryByText(/Loading attachment/)).toBeNull();
    expect(screen.queryByText("image.png")).toBeNull();
  });

  it("shows an overflow count beyond three image thumbnails", async () => {
    vi.mocked(runtimeMedia.blob).mockResolvedValue(new Blob(["img"]));
    const { container } = render(
      <InputQueueStrip
        items={[
          queuedItem({
            id: "q-many",
            contentParts: [
              { type: "image", assetId: "asset_1" },
              { type: "image", assetId: "asset_2" },
              { type: "image", assetId: "asset_3" },
              { type: "image", assetId: "asset_4" },
              { type: "image", assetId: "asset_5" },
            ],
          }),
        ]}
        onRemove={vi.fn()}
        onForce={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(container.querySelectorAll("img.queue-media-thumb")).toHaveLength(
        3,
      );
    });
    expect(screen.getByText("+2")).toBeDefined();
  });

  it("summarizes non-image attachments as a paperclip count chip", () => {
    vi.mocked(runtimeMedia.blob).mockResolvedValue(new Blob(["img"]));
    render(
      <InputQueueStrip
        items={[
          queuedItem({
            id: "q-files",
            contentParts: [
              { type: "image", assetId: "asset_1" },
              { type: "file", assetId: "asset_2" },
              { type: "video", assetId: "asset_3" },
            ],
          }),
        ]}
        onRemove={vi.fn()}
        onForce={vi.fn()}
      />,
    );
    expect(screen.getByText("2")).toBeDefined();
  });

  it("keeps queue items without media unchanged", () => {
    const { container } = render(
      <InputQueueStrip
        items={[queuedItem({ contentParts: undefined })]}
        onRemove={vi.fn()}
        onForce={vi.fn()}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText(/help me with this screenshot/)).toBeDefined();
  });
});
