import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { BlobMarks } from "../checkpoints/blob-marks.js";
it("requires a complete sealed mark before membership queries and rejects later additions", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "synax-blob-marks-")),
    marks = await BlobMarks.create(dir);
  try {
    const hash = "a".repeat(64);
    await marks.mark(JSON.stringify({ hash }));
    expect(() => marks.has(hash)).toThrow(/complete|sealed/i);
    marks.seal();
    expect(marks.has(hash)).toBe(true);
    expect(marks.has("b".repeat(64))).toBe(false);
    await expect(
      marks.mark(JSON.stringify({ hash: "b".repeat(64) })),
    ).rejects.toThrow(/sealed/i);
  } finally {
    await marks.close();
    await fs.rm(dir, { recursive: true, force: true });
  }
});
