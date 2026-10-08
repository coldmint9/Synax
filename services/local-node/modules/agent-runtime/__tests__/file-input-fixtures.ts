import { zipSync, strToU8 } from "fflate";
export const officeTypes = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
function zip(files: Record<string, string>): Buffer {
  return Buffer.from(
    zipSync(
      Object.fromEntries(
        Object.entries({
          "[Content_Types].xml":
            '<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>',
          ...files,
        }).map(([key, value]) => [key, strToU8(value)]),
      ),
    ),
  );
}
export function documentFixtures() {
  return {
    docx: zip({
      "word/document.xml":
        '<w:document xmlns:w="urn:word"><w:body><w:p><w:r><w:t>文档段落 &amp; 内容</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>表格单元</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>42</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>',
    }),
    xlsx: zip({
      "xl/workbook.xml":
        '<workbook xmlns:r="urn:rels"><sheets><sheet name="销售" sheetId="1" r:id="r1"/></sheets></workbook>',
      "xl/_rels/workbook.xml.rels":
        '<Relationships><Relationship Id="r1" Target="worksheets/sheet1.xml"/></Relationships>',
      "xl/sharedStrings.xml": "<sst><si><t>收入</t></si></sst>",
      "xl/worksheets/sheet1.xml":
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1"><v>123.5</v></c><c r="D1" t="inlineStr"><is><t>中文</t></is></c><c r="E1" t="b"><v>1</v></c><c r="F1"><f>C1*2</f><v>247</v></c></row></sheetData></worksheet>',
    }),
    pptx: zip({
      "ppt/presentation.xml":
        '<p:presentation xmlns:p="urn:ppt" xmlns:r="urn:rels"><p:sldIdLst><p:sldId id="1" r:id="r2"/><p:sldId id="2" r:id="r1"/></p:sldIdLst></p:presentation>',
      "ppt/_rels/presentation.xml.rels":
        '<Relationships><Relationship Id="r1" Target="slides/slide1.xml"/><Relationship Id="r2" Target="slides/slide2.xml"/></Relationships>',
      "ppt/slides/slide1.xml":
        '<p:sld xmlns:p="urn:ppt" xmlns:a="urn:drawing"><a:p><a:r><a:t>第二张</a:t></a:r></a:p></p:sld>',
      "ppt/slides/slide2.xml":
        '<p:sld xmlns:p="urn:ppt" xmlns:a="urn:drawing"><a:p><a:r><a:t>第一张</a:t></a:r></a:p></p:sld>',
    }),
    pdf: makePdf(),
  };
}
/** A complete one-page PDF, including xref, with a standard text layer. */
export function makePdf(
  content = "PDF text layer",
  drawing = "",
  pageCount = 1,
) {
  const stream = `BT /F1 12 Tf 72 720 Td (${content}) Tj ET\n${drawing}`;
  const fontId = 3 + pageCount;
  const streamId = fontId + 1;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    `<< /Type /Pages /Kids [${Array.from({ length: pageCount }, (_, i) => `${3 + i} 0 R`).join(" ")}] /Count ${pageCount} >>`,
    ...Array.from(
      { length: pageCount },
      () =>
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${streamId} 0 R >>`,
    ),
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream)} >>\nstream\n${stream}\nendstream`,
  ];
  let value = "%PDF-1.4\n";
  const offsets = [0];
  objects.forEach((object, index) => {
    offsets.push(Buffer.byteLength(value));
    value += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = Buffer.byteLength(value);
  value += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets
    .slice(1)
    .map((offset) => `${String(offset).padStart(10, "0")} 00000 n \n`)
    .join(
      "",
    )}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(value);
}
// A pair of boxes connected by an arrow, drawn as PDF vectors.
export const flowchartDrawing =
  "0 0 1 RG 2 w 72 600 100 40 re S 72 500 100 40 re S 122 600 m 122 540 l S 117 545 m 122 540 l 127 545 l S";
// A small embedded red/green/blue/white bitmap, without an external image file.
export const bitmapDrawing =
  "q 120 0 0 120 72 500 cm BI /W 2 /H 2 /CS /RGB /BPC 8 /F /AHx ID FF000000FF000000FFFFFFFF> EI Q";
