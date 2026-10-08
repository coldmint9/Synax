import { describe, expect, it, vi } from "vitest";
import { strToU8, zipSync } from "fflate";
import { parseFileInput, registerFileParser } from "../file-input/index.js";
import {
  documentFixtures,
  officeTypes,
  makePdf,
  flowchartDrawing,
  bitmapDrawing,
} from "./file-input-fixtures.js";
const fixtures = documentFixtures();
describe("file input parsers", () => {
  it("extracts PDF text when the runtime has no default worker source", async () => {
    const { GlobalWorkerOptions } =
      await import("pdfjs-dist/legacy/build/pdf.mjs");
    const previousWorkerSrc = GlobalWorkerOptions.workerSrc;
    GlobalWorkerOptions.workerSrc = "";
    try {
      const result = await parseFileInput({
        filename: "【PRD】英国生活+_+团购店铺+-+荣汉关联配置功能.pdf",
        mediaType: "application/pdf",
        bytes: fixtures.pdf,
      });
      expect(result.text).toContain("第 1 页");
      expect(result.text).toContain("PDF text layer");
      expect(GlobalWorkerOptions.workerSrc).toMatch(
        /^file:.*\/legacy\/build\/pdf\.worker\.mjs$/,
      );
    } finally {
      GlobalWorkerOptions.workerSrc = previousWorkerSrc;
    }
  });
  it("bounds OOXML expansion before parsing XML", async () => {
    const bytes = zipSync({
      "word/document.xml": new Uint8Array(17 * 1024 * 1024),
    });
    await expect(
      parseFileInput({
        filename: "large.docx",
        mediaType: officeTypes.docx,
        bytes,
      }),
    ).rejects.toThrow("解压尺寸");
  });
  it("allows an extension to override a built-in format and restores it on unregister", async () => {
    const input = {
      filename: "scan.pdf",
      mediaType: "application/pdf",
      bytes: fixtures.pdf,
    };
    const remove = registerFileParser({
      id: "pdf-ocr-extension",
      supports: (file) => file.mediaType === "application/pdf",
      parse: async () => "OCR text",
    });
    try {
      expect((await parseFileInput(input)).parserId).toBe("pdf-ocr-extension");
    } finally {
      remove();
    }
    expect((await parseFileInput(input)).parserId).toBe("pdf");
  });
  it.each(["txt", "md", "csv", "json", "html", "ts", "unknown"])(
    "reads character files regardless of .%s extension",
    async (ext) => {
      const result = await parseFileInput({
        filename: `notes.${ext}`,
        mediaType: "application/octet-stream",
        bytes: Buffer.from("中文内容\nhello"),
      });
      expect(result.text).toContain("中文内容\nhello");
      expect(result.parserId).toBe("character-text");
    },
  );
  it("decodes UTF-16 with a BOM and rejects invalid encodings and binary controls", async () => {
    expect(
      (
        await parseFileInput({
          filename: "utf16.txt",
          mediaType: "text/plain",
          bytes: Buffer.concat([
            Buffer.from([255, 254]),
            Buffer.from("中文", "utf16le"),
          ]),
        })
      ).text,
    ).toContain("中文");
    for (const bytes of [
      Buffer.from([0xff, 0x81, 0x99]),
      Buffer.from([65, 0, 66]),
      Buffer.from([1, 2, 3]),
    ])
      await expect(
        parseFileInput({
          filename: "binary.bin",
          mediaType: "application/octet-stream",
          bytes,
        }),
      ).rejects.toMatchObject({ code: "UNSUPPORTED_FILE" });
  });
  it("extracts PDF text with page markers", async () => {
    const result = await parseFileInput({
      filename: "paper.pdf",
      mediaType: "application/pdf",
      bytes: fixtures.pdf,
    });
    expect(result.text).toContain("第 1 页");
    expect(result.text).toContain("PDF text layer");
  });
  it.each([flowchartDrawing, bitmapDrawing])(
    "renders vector diagrams and embedded bitmaps with text context",
    async (drawing) => {
      const result = await parseFileInput({
        filename: "visual.pdf",
        mediaType: "application/pdf",
        bytes: makePdf("Diagram context", drawing),
        visual: {
          maxPages: 10,
          maxImageBytes: 5 * 1024 * 1024,
          maxTotalBytes: 20 * 1024 * 1024,
        },
      });
      expect(result.text).toContain("Diagram context");
      expect(result.images).toHaveLength(1);
      expect(result.images![0].page).toBe(1);
      expect(Buffer.from(result.images![0].bytes).subarray(0, 8)).toEqual(
        Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
      );
      expect(result.warnings).toEqual([]);
      const { createCanvas, loadImage } = await import("@napi-rs/canvas");
      const decoded = await loadImage(Buffer.from(result.images![0].bytes));
      const canvas = createCanvas(decoded.width, decoded.height);
      const context = canvas.getContext("2d");
      context.drawImage(decoded, 0, 0);
      const pixel =
        drawing === flowchartDrawing
          ? context.getImageData(144, 320, 1, 1).data
          : context.getImageData(160, 360, 1, 1).data;
      expect(pixel[drawing === flowchartDrawing ? 2 : 0]).toBeGreaterThan(200);
      expect(pixel[1]).toBeLessThan(100);
      expect(Math.max(decoded.width, decoded.height)).toBeLessThanOrEqual(2000);
    },
  );
  it("warns text-only models about vector diagrams and scanned pages", async () => {
    for (const [text, drawing] of [
      ["Diagram context", flowchartDrawing],
      ["", bitmapDrawing],
    ]) {
      const result = await parseFileInput({
        filename: "visual.pdf",
        mediaType: "application/pdf",
        bytes: makePdf(text, drawing),
      });
      expect(result.images).toEqual([]);
      expect(result.text).toContain("图片和流程图无法识别");
      expect(result.text).toContain("第 1 页");
      expect(result.text).toContain("请在回复中明确告知用户");
    }
  });
  it("renders scanned pages even without a text layer", async () => {
    const result = await parseFileInput({
      filename: "scan.pdf",
      mediaType: "application/pdf",
      bytes: makePdf("", bitmapDrawing),
      visual: {
        maxPages: 1,
        maxImageBytes: 5 * 1024 * 1024,
        maxTotalBytes: 20 * 1024 * 1024,
      },
    });
    expect(result.images).toHaveLength(1);
    expect(result.warnings).toEqual([]);
  });
  it("keeps PDF text and reports a failed page render", async () => {
    const canvas = await import("@napi-rs/canvas");
    const render = vi
      .spyOn(canvas.default, "createCanvas")
      .mockImplementationOnce(() => {
        throw new Error("Canvas unavailable");
      });
    try {
      const result = await parseFileInput({
        filename: "diagram.pdf",
        mediaType: "application/pdf",
        bytes: makePdf("Preserved context", flowchartDrawing),
        visual: {
          maxPages: 1,
          maxImageBytes: 5 * 1024 * 1024,
          maxTotalBytes: 20 * 1024 * 1024,
        },
      });
      expect(result.text).toContain("Preserved context");
      expect(result.text).toContain("第 1 页的图片或流程图渲染失败");
      expect(result.images).toEqual([]);
    } finally {
      render.mockRestore();
    }
  });
  it("reports omitted pages when page or byte budgets are exhausted", async () => {
    for (const visual of [
      {
        maxPages: 1,
        maxImageBytes: 5 * 1024 * 1024,
        maxTotalBytes: 20 * 1024 * 1024,
      },
      { maxPages: 10, maxImageBytes: 1, maxTotalBytes: 1 },
    ]) {
      const result = await parseFileInput({
        filename: "large.pdf",
        mediaType: "application/pdf",
        bytes: makePdf("Context", flowchartDrawing, 2),
        visual,
      });
      expect(result.images!.length).toBeLessThanOrEqual(1);
      expect(result.text).toContain("第 2 页");
      expect(result.text).toContain("超过本次图片数量或体积限制");
      expect(result.text).toContain("Context");
    }
  });
  it("extracts DOCX paragraphs and table cells", async () => {
    const result = await parseFileInput({
      filename: "report.docx",
      mediaType: officeTypes.docx,
      bytes: fixtures.docx,
    });
    expect(result.text).toContain("文档段落 & 内容");
    expect(result.text).toContain("表格单元\t42");
  });
  it("extracts XLSX sheets, cell addresses, values and cached formulas", async () => {
    const result = await parseFileInput({
      filename: "sales.xlsx",
      mediaType: officeTypes.xlsx,
      bytes: fixtures.xlsx,
    });
    for (const expected of [
      "工作表：销售",
      "A1: 收入",
      "C1: 123.5",
      "D1: 中文",
      "E1: TRUE",
      "F1: 247",
    ])
      expect(result.text).toContain(expected);
  });
  it("extracts PPTX slides in presentation order", async () => {
    const result = await parseFileInput({
      filename: "slides.pptx",
      mediaType: officeTypes.pptx,
      bytes: fixtures.pptx,
    });
    expect(result.text).toContain("幻灯片 1\n第一张");
    expect(result.text).toContain("幻灯片 2\n第二张");
  });
  it("supports trusted parser extensions without changing model capabilities", async () => {
    const input = {
      filename: "custom.bin",
      mediaType: "application/x-custom",
      bytes: Buffer.from([0xff, 0]),
    };
    await expect(parseFileInput(input)).rejects.toMatchObject({
      code: "UNSUPPORTED_FILE",
    });
    const unregister = registerFileParser({
      id: "fixture-custom",
      supports: (file) => file.mediaType === input.mediaType,
      parse: async () => "工具扩展内容",
    });
    try {
      expect(await parseFileInput(input)).toMatchObject({
        parserId: "fixture-custom",
        text: "文件：custom.bin\n工具扩展内容",
      });
    } finally {
      unregister();
    }
    await expect(parseFileInput(input)).rejects.toMatchObject({
      code: "UNSUPPORTED_FILE",
    });
  });
  it("reports corrupt, empty and excessive document text explicitly", async () => {
    await expect(
      parseFileInput({
        filename: "bad.pdf",
        mediaType: "application/pdf",
        bytes: Buffer.from("%PDF-broken"),
      }),
    ).rejects.toMatchObject({ code: "FILE_PARSE_FAILED" });
    await expect(
      parseFileInput({
        filename: "empty.pdf",
        mediaType: "application/pdf",
        bytes: makePdf(""),
      }),
    ).rejects.toMatchObject({ code: "FILE_TEXT_EMPTY" });
    await expect(
      parseFileInput({
        filename: "large.txt",
        mediaType: "text/plain",
        bytes: Buffer.from("a".repeat(100001)),
      }),
    ).rejects.toMatchObject({ code: "FILE_TEXT_TOO_LARGE" });
    const archive = zipSync({
      "word/document.xml": strToU8("a".repeat(17 * 1024 * 1024)),
    });
    await expect(
      parseFileInput({
        filename: "large.docx",
        mediaType: officeTypes.docx,
        bytes: archive,
      }),
    ).rejects.toMatchObject({ code: "FILE_PARSE_FAILED" });
  });
});
