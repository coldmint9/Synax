import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeAsset } from "../../../lib/api/runtimeMedia";
import { runtimeMedia } from "../../../lib/api/runtimeMedia";
import { MediaDraftPreview } from "./MediaDraftControls";
import type { MediaDraft } from "./useMediaDraft";

vi.mock("../../../lib/api/runtimeMedia", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../../lib/api/runtimeMedia")>();
  return {
    ...original,
    runtimeMedia: {
      ...original.runtimeMedia,
      metadata: vi.fn(),
      blob: vi.fn(),
    },
  };
});

const asset: RuntimeAsset = {
  id: "asset_00000000000000000000000000000000",
  projectId: "project-1",
  filename: "image.png",
  mediaType: "image/png",
  size: 1024,
  sha256: "hash",
  createdAt: "2026-01-01T00:00:00.000Z",
};

function createMedia(remove = vi.fn()): MediaDraft {
  return {
    items: [
      {
        id: "draft-1",
        file: new File(["image"], asset.filename, { type: asset.mediaType }),
        asset,
        uploading: false,
        controller: new AbortController(),
      },
    ],
    parts: [{ type: "image", assetId: asset.id }],
    error: null,
    ready: true,
    add: vi.fn(),
    remove,
    retry: vi.fn(),
    clear: vi.fn(),
    restore: vi.fn(),
  };
}

describe("MediaDraftPreview", () => {
  beforeEach(() => {
    vi.mocked(runtimeMedia.metadata).mockResolvedValue({ asset });
    vi.mocked(runtimeMedia.blob).mockResolvedValue(new Blob(["image"]));
    Object.defineProperty(URL, "createObjectURL", {
      configurable: true,
      value: vi.fn(() => "blob:image"),
    });
    Object.defineProperty(URL, "revokeObjectURL", {
      configurable: true,
      value: vi.fn(),
    });
  });

  it("removes the ready row and deletes from the image card corner", async () => {
    const remove = vi.fn();
    const { container } = render(
      <MediaDraftPreview media={createMedia(remove)} />,
    );

    const removeButton = await screen.findByRole("button", {
      name: "移除 image.png",
    });

    expect(screen.queryByText("已就绪 / Ready")).not.toBeInTheDocument();
    expect(screen.getAllByText("image.png")).toHaveLength(1);
    expect(removeButton).toHaveClass("absolute", "right-1.5", "top-1.5");
    expect(container.querySelector('img[alt="image.png"]')).toBeInTheDocument();

    fireEvent.click(removeButton);
    expect(remove).toHaveBeenCalledWith("draft-1");

    await waitFor(() =>
      expect(runtimeMedia.metadata).toHaveBeenCalledWith(asset.id),
    );
  });
});
