import { afterEach, expect, it, vi } from "vitest";
import { signingInputs } from "./prepare-windows-signing.js";

afterEach(() => vi.unstubAllEnvs());

it("accepts a complete persistent signing identity", () => {
  expect(signingInputs({
    SYNAX_WINDOWS_PUBLISHER: "CN=Synax Self-Signed Publisher",
    CSC_LINK: "C:\\signing\\Synax.pfx",
    CSC_KEY_PASSWORD: "secret",
  })).toEqual({
    publisher: "CN=Synax Self-Signed Publisher",
    pfxPath: "C:\\signing\\Synax.pfx",
    password: "secret",
  });
});

it("rejects a partial signing identity", () => {
  expect(() => signingInputs({ CSC_LINK: "certificate.pfx" })).toThrow(
    "CSC_LINK, CSC_KEY_PASSWORD, and SYNAX_WINDOWS_PUBLISHER",
  );
});

it("allows unsigned preview builds without signing inputs", () => {
  expect(signingInputs({})).toBeNull();
});
