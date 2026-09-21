import { createPrivateKey, createPublicKey, sign, verify } from "node:crypto";
import { readFileSync } from "node:fs";
import type { DesktopManifest } from "./desktop-update-format.js";

export function parseUpdatePublicKey(value: string) {
  const key = createPublicKey({
    key: Buffer.from(value.trim(), "base64"),
    format: "der",
    type: "spki",
  });
  if (key.asymmetricKeyType !== "ed25519")
    throw new Error("Desktop updates require an Ed25519 public key");
  return key;
}

let pinnedKey: string | undefined;
export function desktopUpdatePublicKey(): string {
  if (pinnedKey === undefined) {
    const data = JSON.parse(
      readFileSync(
        new URL("../update-public-key.json", import.meta.url),
        "utf8",
      ),
    );
    if (typeof data.publicKey !== "string")
      throw new Error("Invalid desktop update trust configuration");
    if (data.publicKey) parseUpdatePublicKey(data.publicKey);
    pinnedKey = data.publicKey;
  }
  return pinnedKey!;
}

export function desktopManifestSigningBytes(manifest: DesktopManifest): Buffer {
  const artifact = (value: DesktopManifest["artifact"]) => ({
    name: value.name,
    size: value.size,
    sha256: value.sha256,
  });
  return Buffer.from(
    JSON.stringify({
      format: manifest.format,
      version: manifest.version,
      platform: manifest.platform,
      arch: manifest.arch,
      artifact: artifact(manifest.artifact),
      ...(manifest.updateArchive
        ? { updateArchive: artifact(manifest.updateArchive) }
        : {}),
      ...(manifest.blockMap ? { blockMap: artifact(manifest.blockMap) } : {}),
    }),
  );
}

export function signDesktopManifest(
  manifest: DesktopManifest,
  privateKey: string,
  publicKey: string,
): DesktopManifest {
  const key = createPrivateKey(privateKey);
  const expected = parseUpdatePublicKey(publicKey).export({
    format: "der",
    type: "spki",
  });
  if (
    key.asymmetricKeyType !== "ed25519" ||
    !createPublicKey(key)
      .export({ format: "der", type: "spki" })
      .equals(expected)
  )
    throw new Error(
      "Desktop update signing key does not match the pinned public key",
    );
  return {
    ...manifest,
    signature: {
      algorithm: "ed25519",
      value: sign(null, desktopManifestSigningBytes(manifest), key).toString(
        "base64",
      ),
    },
  };
}

/** A pinned key is fail-closed; legacy unsigned clients may only use full downloads. */
export function verifyDesktopManifestSignature(
  manifest: DesktopManifest,
  publicKey = desktopUpdatePublicKey(),
): boolean {
  if (!publicKey) return false;
  if (
    !manifest.signature ||
    manifest.signature.algorithm !== "ed25519" ||
    !verify(
      null,
      desktopManifestSigningBytes(manifest),
      parseUpdatePublicKey(publicKey),
      Buffer.from(manifest.signature.value, "base64"),
    )
  )
    throw new Error("Desktop update manifest signature is missing or invalid");
  return true;
}
