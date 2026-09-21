import { expect, it } from "vitest";
import { boundedPng, parseElementBounds } from "./capture.js";
it("rejects oversized encoded PNG dimensions and malformed annotations", () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlWQAAAAASUVORK5CYII=",
    "base64",
  );
  png.writeUInt32BE(4097, 16);
  expect(() => boundedPng(png)).toThrow("RESOURCE_LIMIT");
  for (const x of [NaN, Infinity, -1, 16385])
    expect(() =>
      parseElementBounds({
        x,
        y: 0,
        width: 10,
        height: 10,
        viewportWidth: 100,
        viewportHeight: 100,
      }),
    ).toThrow();
  expect(() =>
    parseElementBounds({
      x: 99,
      y: 0,
      width: 10,
      height: 10,
      viewportWidth: 100,
      viewportHeight: 100,
    }),
  ).toThrow();
});
