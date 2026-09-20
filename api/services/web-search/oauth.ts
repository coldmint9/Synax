import { createHash, randomBytes } from "node:crypto";
import {
  getGlobalConfigForRuntime,
  updateGlobalConfig,
} from "../../lib/config/config-store.js";
import type {
  WebSearchAuthConfig,
  WebSearchConfig,
} from "../../lib/config/config-types.js";

interface PendingAuthorization {
  codeVerifier: string;
  createdAt: number;
  redirectUri: string;
}

const pending = new Map<string, PendingAuthorization>();
const AUTH_TTL_MS = 10 * 60_000;
const MAX_TOKEN_RESPONSE_BYTES = 1_000_000;
let refreshPromise: Promise<WebSearchAuthConfig> | null = null;

export function beginWebSearchOAuth(redirectUri: string): {
  authorizationUrl: string;
} {
  const config = getGlobalConfigForRuntime().webSearch;
  const auth = requireOAuthConfig(config.local.auth);
  const state = randomBytes(24).toString("base64url");
  const codeVerifier = randomBytes(48).toString("base64url");
  const challenge = createHash("sha256")
    .update(codeVerifier)
    .digest("base64url");
  pending.set(state, { codeVerifier, createdAt: Date.now(), redirectUri });
  sweepPending();

  const url = new URL(auth.authorizationUrl!);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", auth.clientId!);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  if (auth.scopes?.length) url.searchParams.set("scope", auth.scopes.join(" "));
  return { authorizationUrl: url.href };
}

export async function completeWebSearchOAuth(input: {
  state: string;
  code: string;
}): Promise<void> {
  const authorization = pending.get(input.state);
  pending.delete(input.state);
  if (!authorization || Date.now() - authorization.createdAt > AUTH_TTL_MS) {
    throw new Error(
      "OAuth state is invalid or expired. Start authorization again.",
    );
  }
  const current = getGlobalConfigForRuntime();
  const auth = requireOAuthConfig(current.webSearch.local.auth);
  const token = await requestToken(auth, {
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: authorization.redirectUri,
    code_verifier: authorization.codeVerifier,
  });
  persistTokens(current.webSearch, auth, token);
}

export async function resolveWebSearchAuthorization(
  config: WebSearchConfig,
): Promise<Record<string, string>> {
  const auth = config.local.auth;
  if (auth.type === "none") return {};
  if (auth.type === "api-key") {
    if (!auth.apiKey) throw new Error("Web search API key is not configured.");
    return {
      [auth.headerName || defaultApiKeyHeader(config.local.engine)]:
        `${auth.tokenPrefix ?? defaultApiKeyPrefix(config.local.engine)}${auth.apiKey}`,
    };
  }
  if (auth.type === "bearer") {
    if (!auth.bearerToken)
      throw new Error("Web search bearer token is not configured.");
    return {
      [auth.headerName || "Authorization"]:
        `${auth.tokenPrefix ?? "Bearer "}${auth.bearerToken}`,
    };
  }

  let resolved = requireOAuthConfig(auth);
  if (
    !resolved.accessToken ||
    (resolved.expiresAt != null && resolved.expiresAt <= Date.now() + 60_000)
  ) {
    if (!resolved.refreshToken) {
      throw new Error(
        "Web search OAuth authorization is required. Connect the engine in Settings.",
      );
    }
    refreshPromise ??= refreshOAuthToken(config, resolved).finally(() => {
      refreshPromise = null;
    });
    resolved = await refreshPromise;
  }
  return {
    [resolved.headerName || "Authorization"]:
      `${resolved.tokenPrefix ?? "Bearer "}${resolved.accessToken}`,
  };
}

async function refreshOAuthToken(
  config: WebSearchConfig,
  auth: WebSearchAuthConfig,
): Promise<WebSearchAuthConfig> {
  const token = await requestToken(auth, {
    grant_type: "refresh_token",
    refresh_token: auth.refreshToken!,
  });
  return persistTokens(config, auth, token);
}

async function requestToken(
  auth: WebSearchAuthConfig,
  fields: Record<string, string>,
): Promise<Record<string, unknown>> {
  const body = new URLSearchParams({
    ...fields,
    client_id: auth.clientId!,
    ...(auth.clientSecret ? { client_secret: auth.clientSecret } : {}),
  });
  const response = await fetch(auth.tokenUrl!, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
    signal: AbortSignal.timeout(15_000),
  });
  const payload = await readTokenResponse(response);
  if (!response.ok) {
    throw new Error(
      `Web search OAuth token request failed (HTTP ${response.status}): ${String(payload.error_description ?? payload.error ?? "unknown error")}`,
    );
  }
  if (typeof payload.access_token !== "string" || !payload.access_token) {
    throw new Error("Web search OAuth token response has no access_token.");
  }
  return payload;
}

async function readTokenResponse(
  response: Response,
): Promise<Record<string, unknown>> {
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_TOKEN_RESPONSE_BYTES)
        throw new Error("Web search OAuth token response exceeded 1 MB.");
      chunks.push(value);
    }
    const text = Buffer.concat(chunks).toString("utf8");
    if (!text) return {};
    try {
      const value = JSON.parse(text) as unknown;
      return value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    } catch {
      return Object.fromEntries(new URLSearchParams(text));
    }
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

function persistTokens(
  config: WebSearchConfig,
  auth: WebSearchAuthConfig,
  token: Record<string, unknown>,
): WebSearchAuthConfig {
  const expiresIn =
    typeof token.expires_in === "number"
      ? token.expires_in
      : Number(token.expires_in);
  const nextAuth: WebSearchAuthConfig = {
    ...auth,
    accessToken: String(token.access_token),
    refreshToken:
      typeof token.refresh_token === "string"
        ? token.refresh_token
        : auth.refreshToken,
    ...(Number.isFinite(expiresIn) && expiresIn > 0
      ? { expiresAt: Date.now() + expiresIn * 1000 }
      : { expiresAt: undefined }),
  };
  updateGlobalConfig(
    {
      webSearch: {
        ...config,
        local: { ...config.local, auth: nextAuth },
      },
    },
    "web-search-oauth",
  );
  return nextAuth;
}

function requireOAuthConfig(auth: WebSearchAuthConfig): WebSearchAuthConfig {
  if (
    auth.type !== "oauth2" ||
    !auth.authorizationUrl ||
    !auth.tokenUrl ||
    !auth.clientId
  ) {
    throw new Error(
      "Web search OAuth2 requires authorization URL, token URL and client ID.",
    );
  }
  return auth;
}

function defaultApiKeyHeader(
  engine: WebSearchConfig["local"]["engine"],
): string {
  return engine === "brave" ? "X-Subscription-Token" : "Authorization";
}

function defaultApiKeyPrefix(
  engine: WebSearchConfig["local"]["engine"],
): string {
  return engine === "brave" ? "" : "Bearer ";
}

function sweepPending(): void {
  const threshold = Date.now() - AUTH_TTL_MS;
  for (const [state, value] of pending) {
    if (value.createdAt < threshold) pending.delete(state);
  }
}
