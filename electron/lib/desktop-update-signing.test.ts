import { generateKeyPairSync } from "node:crypto";
import { expect, it } from "vitest";
import {
  signDesktopManifest,
  verifyDesktopManifestSignature,
} from "./desktop-update-signing.js";
import {
  validateDesktopManifest,
  type DesktopManifest,
} from "./desktop-update-format.js";

const keys = generateKeyPairSync("ed25519");
const privateKey = keys.privateKey
  .export({ format: "pem", type: "pkcs8" })
  .toString();
const publicKey = keys.publicKey
  .export({ format: "der", type: "spki" })
  .toString("base64");
const manifest: DesktopManifest = {
  format: 1,
  version: "0.3.0",
  platform: "darwin",
  arch: "arm64",
  artifact: {
    name: "Synax-0.3.0-darwin-arm64.dmg",
    size: 1000,
    sha256: "a".repeat(64),
  },
  updateArchive: {
    name: "Synax-0.3.0-darwin-arm64.zip",
    size: 1100,
    sha256: "b".repeat(64),
  },
  blockMap: {
    name: "Synax-0.3.0-darwin-arm64.zip.blockmap",
    size: 100,
    sha256: "c".repeat(64),
  },
};
it("authenticates the version, platform, full archive and blockmap independently of JSON property order", () => {
  const signed = signDesktopManifest(manifest, privateKey, publicKey);
  expect(validateDesktopManifest(signed)).toEqual(signed);
  expect(
    verifyDesktopManifestSignature(
      JSON.parse(JSON.stringify(signed)),
      publicKey,
    ),
  ).toBe(true);
  expect(
    verifyDesktopManifestSignature(
      { signature: signed.signature, ...manifest },
      publicKey,
    ),
  ).toBe(true);
  for (const changed of [
    { ...signed, version: "0.4.0" },
    { ...signed, arch: "x64" as const },
    { ...signed, artifact: { ...signed.artifact, sha256: "d".repeat(64) } },
    { ...signed, updateArchive: { ...signed.updateArchive!, size: 1200 } },
    { ...signed, blockMap: { ...signed.blockMap!, sha256: "d".repeat(64) } },
    { ...signed, blockMap: undefined },
    { ...signed, signature: undefined },
  ])
    expect(() => verifyDesktopManifestSignature(changed, publicKey)).toThrow(
      "signature",
    );
});
it("keeps unsigned full-download compatibility but never authenticates it for differential downloads", () => {
  expect(verifyDesktopManifestSignature(manifest, "")).toBe(false);
  expect(() => verifyDesktopManifestSignature(manifest, publicKey)).toThrow(
    "signature",
  );
  const other = generateKeyPairSync("ed25519")
    .publicKey.export({ format: "der", type: "spki" })
    .toString("base64");
  expect(() => signDesktopManifest(manifest, privateKey, other)).toThrow(
    "does not match",
  );
  expect(() =>
    verifyDesktopManifestSignature(
      signDesktopManifest(manifest, privateKey, publicKey),
      other,
    ),
  ).toThrow("signature");
});
it("rejects invalid archive and blockmap metadata without weakening legacy DMG validation", () => {
  for (const changed of [
    {
      ...manifest,
      updateArchive: { ...manifest.updateArchive!, name: "../escape.zip" },
    },
    { ...manifest, blockMap: { ...manifest.blockMap!, size: 50 * 1024 ** 2 } },
    {
      ...manifest,
      blockMap: { ...manifest.blockMap!, name: "other.blockmap" },
    },
    {
      ...manifest,
      artifact: { ...manifest.artifact, name: "Synax-0.3.0-darwin-arm64.zip" },
    },
  ])
    expect(() => validateDesktopManifest(changed)).toThrow();
  expect(
    validateDesktopManifest({
      ...manifest,
      updateArchive: undefined,
      blockMap: undefined,
    }).artifact.name,
  ).toMatch(/\.dmg$/);
});
