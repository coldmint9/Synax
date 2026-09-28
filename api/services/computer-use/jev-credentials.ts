import { getGlobalConfigForRuntime } from "../../lib/config/config-store.js";
import {
  decryptSecret,
  isEncryptedSecret,
} from "../../lib/config/config-secret.js";

export type JevCredentialSource = "env" | "config";

export interface JevCredentials {
  apiKey: string;
  source: JevCredentialSource;
}

/** The environment variable always wins so operators can override the stored value. */
function environmentKey(): string | undefined {
  const value = process.env.TYPESAFE_API_KEY?.trim();
  return value ? value : undefined;
}

function storedKey(): string | undefined {
  try {
    // Runtime accessor keeps the decrypted secret; the default getter strips it.
    const stored = getGlobalConfigForRuntime().computerUse?.jev?.apiKey;
    if (!stored) return undefined;
    const plain = isEncryptedSecret(stored) ? decryptSecret(stored) : stored;
    const value = plain?.trim();
    return value ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Resolves the Jev API key without ever logging or echoing its value. */
export function resolveJevCredentials(): JevCredentials | null {
  const fromEnvironment = environmentKey();
  if (fromEnvironment)
    return { apiKey: fromEnvironment, source: "env" };
  const fromConfig = storedKey();
  if (fromConfig) return { apiKey: fromConfig, source: "config" };
  return null;
}

export function describeJevCredentialSource(): JevCredentialSource | "missing" {
  return resolveJevCredentials()?.source ?? "missing";
}
