import { describe, expect, it } from "vitest";
import {
  acceptsEnvelope,
  validateControls,
  safeJson,
  feedbackInput,
  injectRuntimeConfig,
  MessageBudget,
} from "../bridge";
const config = {
  protocol: 1 as const,
  instanceId: "instance",
  revisionId: "revision",
  nonce: "nonce",
};
describe("artifact trust boundary", () => {
  it("requires source, nonce, instance, revision and protocol", () => {
    const source = {};
    const data = { ...config, type: "hello" };
    expect(acceptsEnvelope(data, config, source, source)).toBe(true);
    expect(acceptsEnvelope(data, config, {}, source)).toBe(false);
    for (const key of ["nonce", "instanceId", "revisionId", "protocol"])
      expect(
        acceptsEnvelope({ ...data, [key]: "wrong" }, config, source, source),
      ).toBe(false);
    expect(
      acceptsEnvelope(
        { ...data, payload: "x".repeat(32769) },
        config,
        source,
        source,
      ),
    ).toBe(false);
  });
  it("rejects oversized, cyclic, non JSON and pollution values", () => {
    expect(() => safeJson("x".repeat(16384), 16384)).toThrow();
    expect(() =>
      safeJson(JSON.parse('{"__proto__":{"admin":true}}')),
    ).toThrow();
    expect(() => safeJson({ x: undefined })).toThrow();
    expect(() => safeJson({ x: Infinity })).toThrow();
    const cycle: any = {};
    cycle.x = cycle;
    expect(() => safeJson(cycle)).toThrow();
  });
  it("validates controls and values rather than trusting schema", () => {
    expect(
      validateControls([
        {
          key: "size",
          label: "Size",
          type: "range",
          min: 1,
          max: 10,
          defaultValue: 5,
        },
      ]),
    ).toHaveLength(1);
    expect(() =>
      validateControls([
        { key: "__proto__", label: "Bad", type: "text", defaultValue: "" },
      ]),
    ).toThrow();
    expect(() =>
      validateControls([
        {
          key: "size",
          label: "Size",
          type: "range",
          min: 10,
          max: 1,
          defaultValue: 5,
        },
      ]),
    ).toThrow();
    expect(() =>
      validateControls(
        Array(13).fill({
          key: "x",
          label: "X",
          type: "toggle",
          defaultValue: false,
        }),
      ),
    ).toThrow();
  });
  it("never includes privateState or unknown draft fields in feedback", () => {
    const input = feedbackInput(
      { text: "Please fix", privateState: "SECRET", modelState: { page: 1 } },
      {
        privateState: "SECRET",
        modelState: { page: 2 },
        controls: { size: 3 },
        schemaVersion: 1,
        etag: 0,
      },
      "key",
    );
    expect(input).toEqual({
      text: "Please fix",
      parameters: { size: 3 },
      modelState: { page: 1 },
      idempotencyKey: "key",
    });
    expect(JSON.stringify(input)).not.toContain("SECRET");
  });
  it("injects inert credentials before scripts without changing scripts", () => {
    const html = injectRuntimeConfig(
      "<html><head><script>run()</script></head></html>",
      config,
    );
    expect(html.indexOf("synax-artifact-runtime")).toBeLessThan(
      html.indexOf("<script>"),
    );
    expect(html).toContain("<script>run()</script>");
    expect(() =>
      injectRuntimeConfig("<script>run()</script>", config),
    ).toThrow();
  });
  it("permits a bounded burst and rejects flooding", () => {
    const budget = new MessageBudget();
    for (let i = 0; i < 40; i++) expect(budget.take(0)).toBe(true);
    expect(budget.take(0)).toBe(false);
    expect(budget.take(50)).toBe(true);
  });
});
