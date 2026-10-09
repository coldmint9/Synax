import { describe, expect, it } from "vitest";
import { parseFileInput } from "../file-input/index.js";

const png = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

describe("Markdown image input", () => {
  it("extracts inline and reference images with context", async () => {
    const parsed = await parseFileInput({
      filename: "docs/readme.md",
      mediaType: "text/markdown",
      bytes: new TextEncoder().encode("![inline](images/a.png)\n\n![ref][diagram]\n\n[diagram]: images/b.png"),
      visual: { maxPages: 10, maxImageBytes: 1024, maxTotalBytes: 2048 },
      loadImage: async (source) => {
        expect(["images/a.png", "images/b.png"]).toContain(source);
        return png;
      },
    });
    expect(parsed.images).toHaveLength(2);
    expect(parsed.images?.[0]?.mediaType).toBe("image/png");
    expect(parsed.images?.[1]?.context).toContain("第 3 行");
  });

  it("reports local images when the text model has no visual input", async () => {
    const parsed = await parseFileInput({
      filename: "readme.md",
      mediaType: "text/markdown",
      bytes: new TextEncoder().encode("![diagram](diagram.png)"),
    });
    expect(parsed.images).toHaveLength(0);
    expect(parsed.warnings?.[0]).toContain("当前模型不支持图片输入");
  });
});
