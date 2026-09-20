import { getApiOrigin } from "./originConfig";

export const RUNTIME_AUTH_REQUIRED = "synax-runtime-auth-required";
let enabled = false;
let authenticated = false;
let accessToken: string | null = null;
let pending: Promise<void> | null = null;

export function enableRuntimeAuth(): void {
  enabled = true;
}
export function setRuntimeAccessToken(value: string): void {
  accessToken = value.trim() || null;
  authenticated = false;
  pending = null;
}
export function runtimeAuthHeaders(): Record<string, string> {
  return accessToken ? { Authorization: `Bearer ${accessToken}` } : {};
}
export function resetRuntimeAuthentication(): void {
  authenticated = false;
  pending = null;
}
export function runtimeAuthEnabled(): boolean {
  return enabled;
}

export async function ensureRuntimeAuthentication(): Promise<void> {
  if (!enabled || authenticated) return;
  if (pending) return pending;
  pending = (async () => {
    const desktop =
      typeof window !== "undefined"
        ? (
            window as unknown as {
              electronAPI?: { getRuntimeToken?: () => Promise<string> };
            }
          ).electronAPI
        : undefined;
    if (!accessToken && desktop?.getRuntimeToken)
      accessToken = await desktop.getRuntimeToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const response = await fetch(`${getApiOrigin()}/api/auth/session`, {
        method: "POST",
        credentials: "include",
        signal: controller.signal,
        headers: {
          "Content-Type": "application/json",
          ...runtimeAuthHeaders(),
        },
        body: "{}",
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => ({}))) as {
          error?: string;
          code?: string;
        };
        throw Object.assign(
          new Error(body.error ?? "Runtime authentication failed."),
          {
            code:
              body.code ??
              (response.status === 401
                ? "AUTH_REQUIRED"
                : "RUNTIME_UNAVAILABLE"),
          },
        );
      }
      authenticated = true;
    } finally {
      clearTimeout(timer);
    }
  })().finally(() => {
    pending = null;
  });
  return pending;
}

export function notifyRuntimeAuthenticationRequired(): void {
  resetRuntimeAuthentication();
  if (typeof window !== "undefined")
    window.dispatchEvent(new Event(RUNTIME_AUTH_REQUIRED));
}
