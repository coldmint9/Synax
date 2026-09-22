import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, afterEach, it, expect, vi } from "vitest";
import { readVisualizationFile } from "../visualization-file.js";
let temp: string, root: string;
beforeEach(() => {
  temp = fs.mkdtempSync(path.join(os.tmpdir(), "visualize-file-"));
  root = path.join(temp, "workspace");
  fs.mkdirSync(root);
  fs.writeFileSync(path.join(root, "demo.html"), "<button>Demo</button>");
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(temp, { recursive: true, force: true });
});
it("reads an authorized HTML fragment with absolute and relative paths", () => {
  for (const file of ["demo.html", path.join(root, "demo.html")])
    expect(readVisualizationFile(file, [root])).toBe("<button>Demo</button>");
});
it("rejects outside files, sibling prefixes, directories and non-HTML targets", () => {
  const sibling = root + "-other";
  fs.mkdirSync(sibling);
  fs.writeFileSync(path.join(sibling, "demo.html"), "Secret");
  fs.writeFileSync(path.join(root, ".env"), "secret");
  fs.mkdirSync(path.join(root, "folder.html"));
  for (const file of [
    path.join(sibling, "demo.html"),
    "../secret.html",
    ".env",
    "folder.html",
    "https://example.com/demo.html",
    "demo.html\0",
  ])
    expect(() => readVisualizationFile(file, [root])).toThrow();
});
it("rejects symlinks escaping a root or pointing at non-HTML data", () => {
  fs.writeFileSync(path.join(temp, "secret.html"), "secret");
  fs.writeFileSync(path.join(root, ".env"), "secret");
  fs.symlinkSync(
    path.join(temp, "secret.html"),
    path.join(root, "escape.html"),
  );
  fs.symlinkSync(path.join(root, ".env"), path.join(root, "env.html"));
  for (const file of ["escape.html", "env.html"])
    expect(() => readVisualizationFile(file, [root])).toThrow();
});
it("bounds reads and rejects invalid UTF-8", () => {
  fs.writeFileSync(path.join(root, "large.html"), "x".repeat(1_000_001));
  fs.writeFileSync(path.join(root, "binary.html"), Buffer.from([0xff, 0xfe]));
  for (const file of ["large.html", "binary.html"])
    expect(() => readVisualizationFile(file, [root])).toThrow();
});
it("rejects a changed file and closes its descriptor", () => {
  const read = fs.readSync,
    close = vi.spyOn(fs, "closeSync");
  const spy = vi.spyOn(fs, "readSync").mockImplementationOnce(((
    ...args: Parameters<typeof fs.readSync>
  ) => {
    fs.appendFileSync(path.join(root, "demo.html"), "changed");
    return Reflect.apply(read, fs, args);
  }) as typeof fs.readSync);
  expect(() => readVisualizationFile("demo.html", [root])).toThrow("变化");
  expect(spy).toHaveBeenCalled();
  expect(close).toHaveBeenCalledOnce();
});
