import { it, expect, vi } from "vitest";
import {
  acquirePreviewSlot,
  releasePreviewSlot,
  touchPreviewSlot,
} from "../preview-slots";
it("evicts and flushes the least recently focused preview before a third starts", async () => {
  const a = vi.fn(async () => {}),
    b = vi.fn(async () => {}),
    c = vi.fn(async () => {});
  await acquirePreviewSlot("a", a);
  await acquirePreviewSlot("b", b);
  touchPreviewSlot("a");
  await acquirePreviewSlot("c", c);
  expect(a).not.toHaveBeenCalled();
  expect(b).toHaveBeenCalledOnce();
  releasePreviewSlot("a");
  releasePreviewSlot("b");
  releasePreviewSlot("c");
});
