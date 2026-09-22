import { describe, expect, it } from "vitest";
import {
  acceptsEnvelope,
  safeJson,
  injectRuntimeConfig,
  MessageBudget,
} from "../bridge";
const config = {
  protocol: 1 as const,
  instanceId: "instance",
  prototypeId: "revision",
  nonce: "nonce",
};
describe("artifact trust boundary", () => {
  it("requires source, nonce, instance, revision and protocol", () => {
    const source = {};
    const data = { ...config, type: "hello" };
    expect(acceptsEnvelope(data, config, source, source)).toBe(true);
    expect(acceptsEnvelope(data, config, {}, source)).toBe(false);
    for (const key of ["nonce", "instanceId", "prototypeId", "protocol"])
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
