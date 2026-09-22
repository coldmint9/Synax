import { describe, it, expect } from "vitest";
import { parsePrototypeManifests } from "../prototype-manifest.js";
const declaration = JSON.stringify({
  sourcePath: "demo.tsx",
  title: "Demo",
  sourceKind: "react",
});
const fence = "```synax-prototype\n" + declaration + "\n```";
describe("prototype declarations", () => {
  it("parses completed top-level HTML/React only, at most three", () => {
    expect(parsePrototypeManifests(fence)).toHaveLength(1);
    expect(
      parsePrototypeManifests(Array(5).fill(fence).join("\n")),
    ).toHaveLength(3);
    expect(
      parsePrototypeManifests(fence.replace("react", "html"))[0].sourceKind,
    ).toBe("html");
  });
  it("leaves nested, quoted, partial, ordinary and legacy examples inert", () => {
    for (const text of [
      "````text\n" + fence + "\n````",
      fence
        .split("\n")
        .map((x) => "> " + x)
        .join("\n"),
      fence.slice(0, -3),
      fence.replace("synax-prototype", "html"),
      fence.replace("synax-prototype", "synax-artifact"),
      "    " + fence.replaceAll("\n", "\n    "),
    ])
      expect(parsePrototypeManifests(text)).toEqual([]);
  });
  it("rejects paths outside the workspace and unknown fields", () => {
    for (const path of ["../a.html", "/tmp/a.html", "C:\\foo.html"])
      expect(
        parsePrototypeManifests(
          fence.replace("demo.tsx", JSON.stringify(path).slice(1, -1)),
        ),
      ).toEqual([]);
    expect(
      parsePrototypeManifests(
        fence.replace('"Demo"', '"Demo","artifactId":"a"'),
      ),
    ).toEqual([]);
  });
});
