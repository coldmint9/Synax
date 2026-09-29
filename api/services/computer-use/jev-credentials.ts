import { getGlobalConfigForRuntime } from "../../lib/config/config-store.js";
import {
  decryptSecret,
  isEncryptedSecret,
} from "../../lib/config/config-secret.js";

export type JevCredentialSource = "env" | "config" | "provider";

export interface JevCredentials {
  apiKey: string;
  /** Overrides the SDK default (`https://api.typesafe.ai`) when a provider connection is selected. */
  baseURL?: string;
  /** A System One model id; the SDK default `jev-latest` applies when omitted. */
  model?: string;
  providerId?: string;
  source: JevCredentialSource;
}

/** The environment variable always wins so operators can override the stored value. */
function environmentKey(): string | undefined {
  const value = process.env.TYPESAFE_API_KEY?.trim();
  return value ? value : undefined;
}

function jevSettings(): {
  apiKey?: string;
  model?: string | null;
  providerId?: string | null;
} | undefined {
  try {
    return getGlobalConfigForRuntime().computerUse?.jev;
  } catch {
    return undefined;
  }
}

function plainSecret(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  const plain = isEncryptedSecret(value) ? decryptSecret(value) : value;
  const trimmed = plain?.trim();
  return trimmed ? trimmed : undefined;
}

function storedKey(): string | undefined {
  // Runtime accessor keeps the decrypted secret; the default getter strips it.
  return plainSecret(jevSettings()?.apiKey);
}

/** The explicitly configured Jev provider, if any. */
export function configuredJevProviderId(): string | undefined {
  const value = jevSettings()?.providerId?.trim();
  return value ? value : undefined;
}

/**
 * The TypeSafe SDK appends `/v1/systemone` to whatever base URL it is given, so an
 * OpenAI-compatible connection such as `https://openrouter.ai/api/v1` must be trimmed back to
 * `https://openrouter.ai/api` before it reaches the SDK.
 */
export function normalizeJevBaseUrl(
  baseUrl: string | undefined | null,
): string | undefined {
  if (!baseUrl) return undefined;
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (!trimmed) return undefined;
  return trimmed.replace(/\/v1$/i, "") || trimmed;
}

function connectionFor(
  providerId: string,
): { apiKey?: string; baseUrl?: string } | undefined {
  try {
    return getGlobalConfigForRuntime().providerConnections?.[providerId];
  } catch {
    return undefined;
  }
}

/**
 * Resolves the Jev call target without ever logging or echoing the key.
 *
 * A configured provider connection wins over the TypeSafe defaults: it supplies the base URL and,
 * when present, the API key. Environment and stored TypeSafe keys stay as fallbacks so operators
 * can keep a self-hosted endpoint keyed through the environment.
 */
export function resolveJevCredentials(): JevCredentials | null {
  const settings = jevSettings();
  const model = settings?.model?.trim() || undefined;
  const providerId = configuredJevProviderId();

  if (providerId) {
    const connection = connectionFor(providerId);
    const baseURL = normalizeJevBaseUrl(connection?.baseUrl);
    const connectionKey = plainSecret(connection?.apiKey);

    let apiKey = connectionKey;
    let source: JevCredentialSource = "provider";
    if (!apiKey) {
      apiKey = environmentKey();
      if (apiKey) source = "env";
    }
    if (!apiKey) {
      apiKey = storedKey();
      if (apiKey) source = "config";
    }
    if (!apiKey) return null;

    return {
      apiKey,
      ...(baseURL ? { baseURL } : {}),
      ...(model ? { model } : {}),
      providerId,
      source,
    };
  }

  const fromEnvironment = environmentKey();
  if (fromEnvironment)
    return {
      apiKey: fromEnvironment,
      source: "env",
      ...(model ? { model } : {}),
    };
  const fromConfig = storedKey();
  if (fromConfig)
    return {
      apiKey: fromConfig,
      source: "config",
      ...(model ? { model } : {}),
    };
  return null;
}

export function describeJevCredentialSource(): JevCredentialSource | "missing" {
  return resolveJevCredentials()?.source ?? "missing";
}
