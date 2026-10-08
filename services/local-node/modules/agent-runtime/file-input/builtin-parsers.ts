import { unzipSync } from "fflate";
import { createRequire } from "node:module";
import path from "node:path";
import { XMLParser, XMLValidator } from "fast-xml-parser";
import { registerFileParser, type FileParserInput } from "./registry.js";

type Node = Record<string, any>;
const xmlParser = new XMLParser({
  preserveOrder: true,
  ignoreAttributes: false,
  attributeNamePrefix: "",
  processEntities: true,
  trimValues: false,
  parseTagValue: false,
  parseAttributeValue: false,
});
function xml(bytes?: Uint8Array): Node[] {
  if (!bytes) throw new Error("文档缺少必需的 XML 文件。");
  const value = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  if (
    /<!DOCTYPE|<!ENTITY/i.test(value) ||
    XMLValidator.validate(value) !== true
  )
    throw new Error("文档 XML 无效。");
  return xmlParser.parse(value);
}
function nodes(value: Node[], name: string): Node[] {
  const found: Node[] = [];
  for (const node of value)
    for (const [key, children] of Object.entries(node)) {
      if (key === name) found.push(node);
      if (Array.isArray(children)) found.push(...nodes(children, name));
    }
  return found;
}
function text(value: Node[]): string {
  return value
    .map((node) =>
      Object.entries(node)
        .map(([key, children]) => {
          if (key === "#text") return String(children);
          if (key.endsWith(":tab")) return "\t";
          if (key.endsWith(":br")) return "\n";
          return Array.isArray(children) ? text(children) : "";
        })
        .join(""),
    )
    .join("");
}
function paragraphText(value: Node[], tag: string): string[] {
  return nodes(value, tag).map((node) => text(node[tag]));
}
function archive(input: FileParserInput): Record<string, Uint8Array> {
  let size = 0,
    count = 0;
  return unzipSync(input.bytes, {
    filter: (file) => {
      size += file.originalSize;
      if (
        ++count > 2000 ||
        size > 64 * 1024 * 1024 ||
        file.originalSize > 16 * 1024 * 1024
      )
        throw new Error("文档解压尺寸或条目数超过限制。");
      return /^(word|xl|ppt)\/.*\.(xml|rels)$/.test(file.name);
    },
  });
}
const MIME: Record<string, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
function relationshipMap(value: Node[]): Map<string, string> {
  return new Map(
    nodes(value, "Relationship").map((node) => [
      node[":@"].Id,
      node[":@"].Target,
    ]),
  );
}
function relationshipPath(folder: string, target: string): string {
  if (target.startsWith("/")) return target.slice(1);
  const segments = `${folder}/${target}`.split("/");
  const out: string[] = [];
  for (const part of segments) {
    if (part === "..") out.pop();
    else if (part !== ".") out.push(part);
  }
  return out.join("/");
}
async function office(input: FileParserInput, kind: string): Promise<string> {
  const files = archive(input);
  if (kind === "docx") {
    const body = nodes(xml(files["word/document.xml"]), "w:body")[0]?.[
      "w:body"
    ];
    if (!body) throw new Error("DOCX 缺少正文。");
    return body
      .flatMap((node: Node) => {
        if (node["w:p"]) return [text(node["w:p"])];
        if (node["w:tbl"])
          return nodes(node["w:tbl"], "w:tr").map((row) =>
            nodes(row["w:tr"], "w:tc")
              .map((cell) => paragraphText(cell["w:tc"], "w:p").join(" / "))
              .join("\t"),
          );
        return paragraphText([node], "w:p");
      })
      .join("\n");
  }
  if (kind === "xlsx") {
    const shared = files["xl/sharedStrings.xml"]
      ? nodes(xml(files["xl/sharedStrings.xml"]), "si").map((node) =>
          text(node.si),
        )
      : [];
    const relationships = relationshipMap(
      xml(files["xl/_rels/workbook.xml.rels"]),
    );
    return nodes(xml(files["xl/workbook.xml"]), "sheet")
      .map((sheet) => {
        const attrs = sheet[":@"],
          target = relationships.get(attrs["r:id"]);
        if (!target) throw new Error("工作表关系缺失。");
        const value = xml(files[relationshipPath("xl", target)]);
        const rows = nodes(value, "row")
          .map((row) =>
            nodes(row.row, "c")
              .map((cell) => {
                const attrs = cell[":@"] ?? {},
                  raw = nodes(cell.c, "v")
                    .map((v) => text(v.v))
                    .join("");
                const result =
                  attrs.t === "s"
                    ? shared[Number(raw)]
                    : attrs.t === "inlineStr"
                      ? nodes(cell.c, "is")
                          .map((v) => text(v.is))
                          .join("")
                      : attrs.t === "b"
                        ? raw === "1"
                          ? "TRUE"
                          : "FALSE"
                        : raw;
                const formula = nodes(cell.c, "f")
                  .map((v) => text(v.f))
                  .join("");
                if (!result && !formula) return "";
                return `${attrs.r ?? ""}: ${result ?? ""}${formula ? ` [公式: ${formula}]` : ""}`;
              })
              .filter(Boolean)
              .join("\t"),
          )
          .filter(Boolean)
          .join("\n");
        return rows ? `工作表：${attrs.name}\n${rows}` : "";
      })
      .filter(Boolean)
      .join("\n\n");
  }
  const relationships = relationshipMap(
    xml(files["ppt/_rels/presentation.xml.rels"]),
  );
  return nodes(xml(files["ppt/presentation.xml"]), "p:sldId")
    .map((slide, index) => {
      const target = relationships.get(slide[":@"]["r:id"]);
      if (!target) throw new Error("幻灯片关系缺失。");
      const value = paragraphText(
        xml(files[relationshipPath("ppt", target)]),
        "a:p",
      ).join("\n");
      return value.trim() ? `幻灯片 ${index + 1}\n${value}` : "";
    })
    .filter(Boolean)
    .join("\n\n");
}
for (const kind of Object.keys(MIME))
  registerFileParser({
    id: kind,
    supports: (input) => input.mediaType === MIME[kind],
    parse: (input) => office(input, kind),
  });
registerFileParser({
  id: "pdf",
  supports: (input) => input.mediaType === "application/pdf",
  async parse(input) {
    const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
    const require = createRequire(
      typeof __filename === "string" ? __filename : import.meta.url,
    );
    const root = path.dirname(require.resolve("pdfjs-dist/package.json"));
    const task = getDocument({
      data: Uint8Array.from(input.bytes),
      cMapUrl: `${path.join(root, "cmaps")}${path.sep}`,
      cMapPacked: true,
      standardFontDataUrl: `${path.join(root, "standard_fonts")}${path.sep}`,
      useSystemFonts: true,
      isEvalSupported: false,
      useWorkerFetch: false,
    });
    try {
      const document = await task.promise;
      if (document.numPages > 1000)
        throw new Error("PDF 页数超过 1000 页，请拆分读取。");
      const pages: string[] = [];
      let length = 0;
      for (let index = 1; index <= document.numPages; index++) {
        const page = await document.getPage(index);
        const content = await page.getTextContent();
        const value = content.items
          .map((item) =>
            "str" in item ? `${item.str}${item.hasEOL ? "\n" : " "}` : "",
          )
          .join("")
          .trim();
        length += value.length;
        if (length > 100_000)
          throw new Error("PDF 文字超过 100000 字符，请拆分读取。");
        if (value) pages.push(`第 ${index} 页\n${value}`);
        page.cleanup();
      }
      return pages.join("\n\n");
    } finally {
      await task.destroy();
    }
  },
});
