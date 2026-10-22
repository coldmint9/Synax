import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RuntimeAsset } from "../../adapters/transport/runtimeMedia";
import { runtimeMedia } from "../../adapters/transport/runtimeMedia";
import { MediaDraftPreview } from "./MediaDraftControls";
import type { MediaDraft } from "./useMediaDraft";

vi.mock("../../adapters/transport/runtimeMedia", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../adapters/transport/runtimeMedia")>();
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
    blocked: false,
    uploading: false,
    add: vi.fn(),
    addText: vi.fn(),
    remove,
    retry: vi.fn(),
    clear: vi.fn(),
    restore: vi.fn(),
    hasPendingUploads: () => false,
    waitForUploads: vi.fn(async () => ({ parts: [], itemIds: [] })),
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

  it("keeps a loading status visible while the attachment body is pending", async () => {
    vi.mocked(runtimeMedia.blob).mockReturnValueOnce(new Promise(() => {}));
    render(<MediaDraftPreview media={createMedia()} />);
    expect(screen.getByRole("status")).toHaveAttribute("aria-busy", "true");
    await screen.findByText("image.png");
    expect(screen.getByRole("status")).toHaveTextContent("正在读取内容");
    expect(screen.queryByRole("img")).not.toBeInTheDocument();
  });

  it("retries a failed attachment download", async () => {
    vi.mocked(runtimeMedia.blob).mockRejectedValueOnce(new Error("Network error"));
    render(<MediaDraftPreview media={createMedia()} />);
    expect(await screen.findByRole("alert")).toHaveTextContent("Network error");
    fireEvent.click(screen.getByRole("button", { name: "重试" }));
    expect(await screen.findByRole("img", { name: "image.png" })).toBeInTheDocument();
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("shows a queued attachment immediately from the local file", () => {
    const media = createMedia();
    media.items = [
      {
        id: "draft-2",
        file: new File(["notes"], "notes.txt", { type: "text/plain" }),
        uploading: true,
        queued: true,
        controller: new AbortController(),
      },
    ];
    media.parts = [];
    media.uploading = true;

    render(<MediaDraftPreview media={media} />);

    expect(screen.getByText("notes.txt")).toBeInTheDocument();
    expect(screen.getByText("排队中 / Queued")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "移除 notes.txt" }));
    expect(media.remove).toHaveBeenCalledWith("draft-2");
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
    expect(screen.queryByText("image.png")).not.toBeInTheDocument();
    expect(removeButton).toHaveClass("absolute", "right-1.5", "top-1.5");
    expect(container.querySelector('img[alt="image.png"]')).toBeInTheDocument();
    expect(
      screen.queryByRole("link", { name: "下载 image.png" }),
    ).not.toBeInTheDocument();

    fireEvent.click(removeButton);
    expect(remove).toHaveBeenCalledWith("draft-1");

    await waitFor(() =>
      expect(runtimeMedia.metadata).toHaveBeenCalledWith(asset.id),
    );
  });
});
