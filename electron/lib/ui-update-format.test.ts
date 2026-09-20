import { describe, expect, it } from "vitest";
import {
  decodeUiArchive,
  encodeUiArchive,
  sha256,
  validateManifest,
  validUiPath,
} from "./ui-update-format.js";

const bytes = Buffer.from("<div>Synax</div>");
const file = { path: "index.html", sha256: sha256(bytes), size: bytes.length };
const archive = encodeUiArchive(new Map([[file.path, bytes]]));
const manifest = {
  format: 1,
  version: "1.0.0",
  appVersion: "0.1.2",
  files: [file],
  full: {
    name: "ui-full.json.gz",
    sha256: sha256(archive),
    size: archive.length,
  },
};

describe("UI resource format", () => {
  it("round trips only the declared files", () => {
    expect(decodeUiArchive(archive, [file]).get("index.html")).toEqual(bytes);
    expect(validateManifest(manifest)).toEqual(manifest);
    expect(() =>
      decodeUiArchive(archive, [{ ...file, sha256: "0".repeat(64) }]),
    ).toThrow("checksum");
    expect(() => decodeUiArchive(archive, [])).toThrow();
  });

  it.each([
    "../secret",
    "/absolute",
    "a/../../b",
    "a\\b",
    "C:/foo",
    "a//b",
    "a:stream",
    "a/CON",
    "a/trailing. ",
  ])("rejects unsafe file path %s", (name) => {
    expect(validUiPath(name)).toBe(false);
  });

  it("rejects duplicate and incomplete manifests", () => {
    expect(() =>
      validateManifest({ ...manifest, files: [file, file] }),
    ).toThrow();
    expect(() =>
      validateManifest({
        ...manifest,
        files: [{ ...file, path: "assets/a.js" }],
      }),
    ).toThrow();
    expect(() =>
      validateManifest({
        ...manifest,
        delta: {
          name: "ui-delta.json.gz",
          sha256: "0".repeat(64),
          size: 10,
          baseVersion: "0.9.0",
          paths: ["../bad"],
        },
      }),
    ).toThrow();
  });
});
