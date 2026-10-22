import { expect, it } from "vitest";
import { mergeProviderOptions, normalizeProviderOptionsNamespace } from "../connection-options.js";
it("merges connection and request settings without mutating either layer", () => {
  const connection = { openai: { store: true, custom: "preserved" } };
  const request = { openai: { store: false }, another: { enabled: true } };
  expect(mergeProviderOptions(connection, request)).toEqual({ openai: { store: false, custom: "preserved" }, another: { enabled: true } });
  expect(connection.openai.store).toBe(true);
});
it("retains legacy custom provider namespaces for saved settings", () => {
  expect(normalizeProviderOptionsNamespace("custom-api:gateway.chat")).toBe("custom-api:gateway");
});
