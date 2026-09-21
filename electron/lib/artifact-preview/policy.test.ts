import { describe, expect, it } from "vitest";
import {
  clipBounds,
  parseCreate,
  parseUpdate,
  safeMessage,
  allowBundleRequest,
  RateLimit,
  assertOwner,
  isTrustedHostURL,
  validateEnvelope,
} from "./policy.js";
const input = {
  id: "preview-1",
  html: "<p>hello</p>",
  revisionId: "revision-1",
  nonce: "a".repeat(32),
  bounds: { x: 0, y: 0, width: 300, height: 200 },
};
describe("artifact transport policy", () => {
  it("accepts only the installed app or configured development origin", () => {
    expect(isTrustedHostURL("app://./index.html")).toBe(true);
    expect(
      isTrustedHostURL("http://localhost:5173", "http://localhost:5173"),
    ).toBe(true);
    for (const url of [
      "app://evil/index.html",
      "https://example.com",
      "file:///index.html",
      "data:text/html,hi",
      "http://localhost:5174",
      "http://localhost:5173@evil/",
    ])
      expect(isTrustedHostURL(url, "http://localhost:5173")).toBe(false);
  });
  it("requires protocol, revision, instance and nonce plus direction-specific types", () => {
    const identity = {
      id: "one",
      nonce: "n".repeat(32),
      revisionId: "revision-one",
    };
    const message = {
      protocol: 1,
      instanceId: identity.id,
      nonce: identity.nonce,
      revisionId: identity.revisionId,
      type: "hello",
    };
    expect(() => validateEnvelope(message, identity, "runtime")).not.toThrow();
    for (const key of ["protocol", "instanceId", "nonce", "revisionId"])
      expect(() =>
        validateEnvelope({ ...message, [key]: "wrong" }, identity, "runtime"),
      ).toThrow();
    expect(() => validateEnvelope(message, identity, "host")).toThrow();
    expect(() =>
      validateEnvelope(
        { ...message, type: "executeJavaScript" },
        identity,
        "host",
      ),
    ).toThrow();
  });

  it("accepts only one exact GET document from the preview renderer, once", () => {
    const url = "synax-artifact://token/index.html";
    const request = {
      url,
      method: "GET",
      resourceType: "mainFrame",
      webContentsId: 12,
    };
    expect(allowBundleRequest(request, url, 12, false)).toBe(true);
    for (const other of [
      "http://localhost:3000",
      "https://example.com",
      "file:///etc/passwd",
      `${url}?q=1`,
      `${url}#hash`,
      "synax-artifact://other/index.html",
      "data:text/html,hi",
      "ws://localhost",
    ])
      expect(
        allowBundleRequest({ ...request, url: other }, url, 12, false),
      ).toBe(false);
    expect(allowBundleRequest(request, url, 13, false)).toBe(false);
    expect(allowBundleRequest(request, url, 12, true)).toBe(false);
    expect(
      allowBundleRequest(
        { ...request, resourceType: "subFrame" },
        url,
        12,
        false,
      ),
    ).toBe(false);
    expect(
      allowBundleRequest({ ...request, method: "POST" }, url, 12, false),
    ).toBe(false);
  });
  it("rejects oversized bundles, bogus IDs, and non-finite or giant geometry", () => {
    expect(parseCreate(input)).toEqual(input);
    for (const value of [NaN, Infinity, -1, 16385])
      expect(() =>
        parseCreate({ ...input, bounds: { ...input.bounds, width: value } }),
      ).toThrow();
    expect(() =>
      parseCreate({ ...input, html: "x".repeat(10 * 1024 * 1024 + 1) }),
    ).toThrow();
    expect(() => parseCreate({ ...input, id: "../bad" })).toThrow();
    expect(() => parseCreate({ ...input, nonce: "short" })).toThrow();
    expect(() =>
      parseUpdate({ id: input.id, bounds: input.bounds, visible: "true" }),
    ).toThrow();
  });
  it("crops rather than resizes content, accounting for viewport/ancestor/zoom", () => {
    expect(
      clipBounds({ x: -20, y: 30, width: 300, height: 200 }, 500, 150, 1),
    ).toEqual({
      outer: { x: 0, y: 30, width: 280, height: 120 },
      inner: { x: -20, y: 0, width: 300, height: 200 },
    });
    expect(
      clipBounds(
        {
          x: 20,
          y: 20,
          width: 300,
          height: 200,
          clip: { x: 40, y: 50, width: 100, height: 80 },
        },
        1000,
        800,
        2,
      ),
    ).toEqual({
      outer: { x: 80, y: 100, width: 200, height: 160 },
      inner: { x: -40, y: -60, width: 600, height: 400 },
    });
    expect(
      clipBounds({ x: 600, y: 0, width: 100, height: 100 }, 500, 500, 1),
    ).toBeNull();
  });
  it("rounds clipped edges inward and rejects empty clips", () => {
    expect(
      clipBounds({ x: 0.2, y: 0.2, width: 10.2, height: 10.2 }, 10, 10, 1)
        ?.outer,
    ).toEqual({ x: 1, y: 1, width: 9, height: 9 });
    expect(
      clipBounds(
        { ...input.bounds, clip: { x: 0, y: 0, width: 0, height: 0 } },
        500,
        500,
        1,
      ),
    ).toBeNull();
  });
  it("rejects spoofed senders, subframes and detached owners", () => {
    const frame = {};
    const sender = { mainFrame: frame };
    const win = { webContents: sender, isDestroyed: () => false };
    expect(() =>
      assertOwner({ sender, senderFrame: frame }, win),
    ).not.toThrow();
    expect(() =>
      assertOwner({ sender: { mainFrame: frame }, senderFrame: frame }, win),
    ).toThrow();
    expect(() => assertOwner({ sender, senderFrame: {} }, win)).toThrow();
    expect(() => assertOwner({ sender, senderFrame: frame }, null)).toThrow();
  });
  it("bounds JSON size, nesting, and pollution without truncating values", () => {
    expect(safeMessage({ type: "hello" })).toEqual({ type: "hello" });
    for (const value of [
      null,
      [],
      { type: "x", data: "x".repeat(32768) },
      JSON.parse('{"__proto__":{}}'),
      { x: { constructor: {} } },
      { value: Infinity },
      { bad: undefined },
    ])
      expect(() => safeMessage(value)).toThrow();
    let deep: any = {};
    for (let i = 0; i < 40; i++) deep = { deep };
    expect(() => safeMessage(deep)).toThrow();
  });
  it("allows a burst of 40 then refills at 20/second", () => {
    const limit = new RateLimit(0);
    for (let i = 0; i < 40; i++) expect(limit.take(0)).toBe(true);
    expect(limit.take(0)).toBe(false);
    expect(limit.take(50)).toBe(true);
    expect(limit.take(50)).toBe(false);
  });
});
