import { createDefaultWebSearchConfig } from "./config-defaults.js";
import {
  decryptSecret,
  encryptSecret,
  isEncryptedSecret,
  maskSecret,
} from "./config-secret.js";
import type { WebSearchAuthConfig, WebSearchConfig } from "./config-types.js";

const SECRET_FIELDS = [
  ["apiKey", "apiKeyMasked"],
  ["bearerToken", "bearerTokenMasked"],
  ["clientSecret", "clientSecretMasked"],
  ["accessToken", "accessTokenMasked"],
  ["refreshToken", "refreshTokenMasked"],
] as const;

export function normalizeWebSearchConfig(
  value: WebSearchConfig | undefined,
  includeSecrets: boolean,
): WebSearchConfig {
  const defaults = createDefaultWebSearchConfig();
  const auth = value?.local?.auth ?? defaults.local.auth;
  return {
    ...defaults,
    ...value,
    remote: { ...defaults.remote, ...(value?.remote ?? {}) },
    local: {
      ...defaults.local,
      ...(value?.local ?? {}),
      auth: normalizeAuth(auth, includeSecrets),
    },
  };
}

/** Preserve secrets omitted by the settings UI while replacing non-secret fields. */
export function mergeWebSearchConfig(
  current: WebSearchConfig,
  patch: WebSearchConfig,
): WebSearchConfig {
  if (current.local.auth.type !== patch.local.auth.type) return patch;
  const auth: WebSearchAuthConfig = { ...patch.local.auth };
  for (const [secretField, maskedField] of SECRET_FIELDS) {
    const incoming = patch.local.auth[secretField];
    const masked = patch.local.auth[maskedField];
    const existing = current.local.auth[secretField];
    if (
      typeof incoming !== "string" &&
      typeof existing === "string" &&
      (typeof masked === "string" || !(secretField in patch.local.auth))
    ) {
      Object.assign(auth, { [secretField]: existing, [maskedField]: masked });
    }
  }
  return { ...patch, local: { ...patch.local, auth } };
}

export function prepareWebSearchConfigForStorage(
  value: WebSearchConfig,
): WebSearchConfig {
  const normalized = normalizeWebSearchConfig(value, true);
  const auth: WebSearchAuthConfig = { ...normalized.local.auth };
  for (const [secretField, maskedField] of SECRET_FIELDS) {
    const raw = auth[secretField];
    const secret = typeof raw === "string" ? raw : undefined;
    Object.assign(auth, {
      [secretField]: encryptSecret(secret),
      [maskedField]: maskSecret(secret),
    });
  }
  return { ...normalized, local: { ...normalized.local, auth } };
}

function normalizeAuth(
  value: WebSearchAuthConfig,
  includeSecrets: boolean,
): WebSearchAuthConfig {
  const auth: WebSearchAuthConfig = { ...value };
  for (const [secretField, maskedField] of SECRET_FIELDS) {
    const raw = value[secretField];
    const secret = typeof raw === "string" ? raw : undefined;
    const plain = secret
      ? isEncryptedSecret(secret)
        ? decryptSecret(secret)
        : secret
      : undefined;
    Object.assign(auth, {
      [secretField]: includeSecrets ? plain : undefined,
      [maskedField]:
        value[maskedField] ?? (secret ? maskSecret(secret) : undefined),
    });
  }
  return auth;
}
