import { describe, expect, it } from "vitest";
import { strToU8, zipSync } from "fflate";
import { parseFileInput, registerFileParser } from "../file-input/index.js";
import {
  documentFixtures,
  officeTypes,
  makePdf,
} from "./file-input-fixtures.js";
const fixtures = documentFixtures();
describe("file input parsers", () => {
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
