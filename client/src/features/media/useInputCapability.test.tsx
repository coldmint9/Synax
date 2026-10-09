import { renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useInputCapability } from "./useInputCapability";
import type { MediaDraft } from "./useMediaDraft";
import { apiRequest } from "../../adapters/transport/origin";
vi.mock("../../adapters/transport/origin", () => ({ apiRequest: vi.fn() }));
beforeEach(() => vi.clearAllMocks());
function draft(
  mediaType: string,
  type: "file" | "image" = "file",
  size = 1024,
): MediaDraft {
  return {
    parts: [{ type, assetId: "asset_test" }],
    items: [
      { asset: { id: "asset_test", mediaType, filename: "attachment", size } },
    ],
  } as MediaDraft;
}
describe("provider capabilities only gate visual attachments", () => {
  it.each(["text/plain", "text/csv", "application/json", "image/svg+xml"])(
    "does not require provider media declarations for %s",
    async (mime) => {
      const { result } = renderHook(() =>
        useInputCapability(
          "project",
          "session",
          "native",
          "text-only",
          draft(mime),
        ),
      );
      await waitFor(() => expect(result.current.blocked).toBe(false));
      expect(apiRequest).not.toHaveBeenCalled();
    },
  );
  it("still blocks an image on a text-only provider", async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      modalities: ["text"],
      verified: true,
      maxFileBytes: 50 * 1024 * 1024,
      maxTotalBytes: 50 * 1024 * 1024,
    });
    const { result } = renderHook(() =>
      useInputCapability(
        "project",
        "session",
        "native",
        "text-only",
        draft("image/png", "image"),
      ),
    );
    await waitFor(() =>
      expect(result.current.text).toContain("当前模型不支持"),
    );
    expect(result.current.blocked).toBe(true);
  });
  it.each([
    { modalities: ["text"], verified: true },
    { modalities: ["text"], verified: false },
  ])(
    "warns about PDF visuals without blocking text input",
    async (capability) => {
      vi.mocked(apiRequest).mockResolvedValue({
        ...capability,
        maxFiles: 10,
        maxFileBytes: 50 * 1024 * 1024,
        maxTotalBytes: 100 * 1024 * 1024,
      });
      const { result } = renderHook(() =>
        useInputCapability(
          "project",
          "session",
          "native",
          "text-only",
          draft("application/pdf"),
        ),
      );
      await waitFor(() =>
        expect(result.current.text).toContain("图片、图表和流程图无法识别"),
      );
      expect(result.current.blocked).toBe(false);
      expect(result.current.error).toBe(false);
    },
  );
  it("shows that PDF visuals are included when the model accepts images", async () => {
    vi.mocked(apiRequest).mockResolvedValue({
      modalities: ["text", "image"],
      verified: true,
      maxFiles: 10,
      maxFileBytes: 50 * 1024 * 1024,
      maxTotalBytes: 100 * 1024 * 1024,
    });
    const { result } = renderHook(() =>
      useInputCapability(
        "project",
        "session",
        "native",
        "vision",
        draft("application/pdf"),
      ),
    );
    await waitFor(() =>
      expect(result.current.text).toContain("结合文字、图片和流程图"),
    );
    expect(result.current.blocked).toBe(false);
  });
  it.each([
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ])(
    "checks Office visual capability without blocking text-only input: %s",
    async (mediaType) => {
      vi.mocked(apiRequest).mockResolvedValue({
        modalities: ["text"],
        verified: true,
        maxFiles: 10,
        maxFileBytes: 50 * 1024 * 1024,
        maxTotalBytes: 100 * 1024 * 1024,
      });
      const { result } = renderHook(() =>
        useInputCapability(
          "project",
          "session",
          "native",
          "text",
          draft(mediaType),
        ),
      );
      await waitFor(() =>
        expect(result.current.text).toContain("图片、图表和流程图无法识别"),
      );
      expect(result.current.blocked).toBe(false);
      expect(apiRequest).toHaveBeenCalled();
    },
  );
});
