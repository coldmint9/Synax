import { describe, expect, it } from "vitest";
import { parseVisualization } from "../visualization-manifest.js";
const html =
  '<div id="demo"><button>Continue</button></div><style>#demo{color:var(--foreground)}</style><script>document.getElementById("demo").dataset.ready="true"</script>';
const fence = (fragment = html) => `\`\`\`synax-visualize\n${fragment}\n\`\`\``;

describe("inline visualization protocol", () => {
  it("retains exact fragment and surrounding message offsets", () => {
    const content = `Before\n${fence()}\nAfter`;
    const result = parseVisualization(content)!;
    expect(result.html).toBe(html);
    expect(content.slice(0, result.start)).toBe("Before\n");
    expect(content.slice(result.end)).toBe("\nAfter");
  });
  it.each([
    "```html\n<button>Example</button>\n```",
    "```synax-prototype\n{}\n```",
    "```synax-visualize\n<div>unfinished</div>",
    fence()
      .split("\n")
      .map((line) => `> ${line}`)
      .join("\n"),
    fence()
      .split("\n")
      .map((line) => `    ${line}`)
      .join("\n"),
    `~~~~markdown\n${fence()}\n~~~~`,
    "```synax-visualize example\n<button>Example</button>\n```",
  ])("keeps examples / incomplete blocks inert: %s", (content) => {
    expect(parseVisualization(content)).toBeNull();
  });
  it("accepts CRLF and tilde fences", () => {
    expect(
      parseVisualization(`~~~synax-visualize\r\n${html}\r\n~~~`)?.html,
    ).toBe(html);
  });
  it.each([
    "<!doctype html><html><body>x</body></html>",
    '<iframe src="https://example.com"></iframe>',
    '<meta http-equiv="refresh" content="0;url=https://example.com">',
    '<base href="https://example.com">',
    '<template><object data="secret"></object></template>',
    '<script src="https://example.com/test.js"></script>',
    '<link rel="stylesheet" href="style.css">',
    "",
  ])("rejects invalid / non-self-contained fragments: %s", (fragment) => {
    expect(parseVisualization(fence(fragment))).toMatchObject({
      error: expect.any(String),
    });
    expect(parseVisualization(fence(fragment))?.html).toBeUndefined();
  });
  it("rejects multiple previews and enforces UTF-8 byte and DOM complexity limits", () => {
    expect(parseVisualization(`${fence()}\n${fence()}`)?.error).toContain(
      "一个",
    );
    expect(
      parseVisualization(fence(`<div>${"你".repeat(340_000)}</div>`))?.error,
    ).toContain("1 MB");
    expect(
      parseVisualization(fence("<b></b>".repeat(6000)))?.error,
    ).toBeTruthy();
    expect(parseVisualization("x".repeat(2_000_001))).toBeNull();
  });
});

describe("visualize skill file references", () => {
  const ref =
    'visualize{"path":"/workspace/.tmp/navbar-demo/navbar-demo.html","mode":"wide","title":"Synax 导航栏 Demo"}';
  it("parses the exact protocol emitted in the reported reply", () => {
    expect(parseVisualization(`Before\n\n${ref}\n\nAfter`)).toEqual({
      sourcePath: "/workspace/.tmp/navbar-demo/navbar-demo.html",
      title: "Synax 导航栏 Demo",
      mode: "wide",
      start: 8,
      end: 8 + ref.length,
    });
    expect(
      parseVisualization(`Before\r\n${ref}\r\nAfter`)?.sourcePath,
    ).toBeTruthy();
  });
  it.each([
    `\`\`\`text\n${ref}\n\`\`\``,
    `> ${ref}`,
    `- ${ref}`,
    `    ${ref}`,
    `\`code\n${ref}\nexample\``,
    `Example ${ref}`,
    ref.slice(0, -1),
  ])(
    "does not execute nested examples or incomplete references: %s",
    (value) => {
      expect(parseVisualization(value)).toBeNull();
    },
  );
  it.each([
    '{"path":42}',
    '{"path":"demo.html","mode":"fullscreen"}',
    '{"path":"demo.html","unexpected":true}',
    "{invalid}",
  ])("reports malformed references without treating them as HTML", (value) => {
    expect(parseVisualization(`visualize${value}`)).toMatchObject({
      error: expect.any(String),
    });
  });
  it("enforces one preview across both protocols", () => {
    expect(parseVisualization(`${ref}\n\n${fence()}`)?.error).toContain("一个");
  });
});
