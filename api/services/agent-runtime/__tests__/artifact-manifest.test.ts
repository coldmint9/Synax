import { describe, it, expect } from "vitest";
import { parseArtifactManifests } from "../artifact-manifest.js";
const manifest = JSON.stringify({
  sourcePath: "demo.html",
  title: "Demo",
  sourceKind: "html",
});
describe("completed artifact manifests", () => {
  it("recognizes top-level complete explicit fences", () =>
    expect(
      parseArtifactManifests("Intro\n```synax-artifact\n" + manifest + "\n```"),
    ).toHaveLength(1));
  it("does not run unfinished, quoted, or nested example fences", () => {
    for (const s of [
      "```synax-artifact\n" + manifest,
      "> ```synax-artifact\n> " + manifest + "\n> ```",
      "````md\n```synax-artifact\n" + manifest + "\n```\n````",
    ])
      expect(parseArtifactManifests(s)).toEqual([]);
  });
  it("limits and validates untrusted manifests", () => {
    expect(
      parseArtifactManifests(
        '```synax-artifact\n{"sourcePath":"/etc/passwd","title":"x"}\n```',
      ),
    ).toEqual([]);
    expect(
      parseArtifactManifests(
        '```synax-artifact\n{"sourcePath":"a.html","title":"x","sourceKind":"html","sessionId":"victim"}\n```',
      ),
    ).toEqual([]);
  });
});

it("keeps an indented outer code example inert", () => {
  expect(parseArtifactManifests(" ````text\n```synax-artifact\n" + manifest + "\n```\n ````")).toEqual([]);
});
