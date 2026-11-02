import { afterEach, describe, expect, it, vi } from "vitest";
import { externalCommandEnvironment } from "../command-environment.js";
import { wslLauncherEnvironment } from "../../wsl/wsl.js";

afterEach(() => vi.unstubAllEnvs());

function hostEnvironment() {
  const host = {
    NODE_ENV: "production",
    DATA_ROOT: "/app/data",
    SYNAX_RUNTIME_DATA_ROOT: "/app/data",
    SYNAX_AGENT_SESSION_CHILD: "1",
    AGENT_SESSION_INIT: '{"sessionId":"host"}',
    SYNAX_RUNTIME_SIDECAR_SOCKET: "/app/runtime.sock",
    SYNAX_RUNTIME_SIDECAR_TOKEN: "host-secret",
    SYNAX_RUNTIME_PROVIDER_PORT: "3210",
    SYNAX_RUNTIME_STORE_PATH: "/app/data/jsonl",
    SYNAX_RUNTIME_LOG_DIR: "/app/data/logs",
    SYNAX_RUNTIME_TICKET_SECRET: "ticket-secret",
    SYNAX_RUNTIME_SIDECAR_SUPERVISOR: "1",
    SYNAX_RUNTIME_FUTURE_CONNECTION: "host-state",
  };
  for (const [key, value] of Object.entries(host)) vi.stubEnv(key, value);
  return host;
}

describe("external command environment", () => {
  it("removes host connections even when bash passes a full environment copy", () => {
    hostEnvironment();
    const before = { ...process.env };
    const env = externalCommandEnvironment({ ...process.env, CI: "1", HOME: "/session/home" });
    expect(Object.keys(env).filter(key => key.startsWith("SYNAX_RUNTIME_"))).toEqual([]);
    expect(env).not.toHaveProperty("SYNAX_AGENT_SESSION_CHILD");
    expect(env).not.toHaveProperty("AGENT_SESSION_INIT");
    expect(env).not.toHaveProperty("DATA_ROOT");
    expect(env).not.toHaveProperty("NODE_ENV");
    expect(env).toMatchObject({ PATH: process.env.PATH, CI: "1", HOME: "/session/home" });
    expect(process.env).toEqual(before);
  });

  it("preserves application-specific overrides without reintroducing host credentials", () => {
    hostEnvironment();
    const env = externalCommandEnvironment({ NODE_ENV: "test", DATA_ROOT: "/test/data", APP_TOKEN: "application", SYNAX_RUNTIME_SIDECAR_TOKEN: "override" }, false);
    expect(env).toEqual({ NODE_ENV: "test", DATA_ROOT: "/test/data", APP_TOKEN: "application" });
  });

  it("keeps ordinary terminal environment settings outside a runtime host", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("DATA_ROOT", "/project/data");
    expect(externalCommandEnvironment()).toMatchObject({ NODE_ENV: "development", DATA_ROOT: "/project/data" });
  });

  it("also removes inherited connections and WSLENV forwarding entries for WSL commands", () => {
    hostEnvironment();
    vi.stubEnv("WSLENV", "SYNAX_RUNTIME_SIDECAR_TOKEN/u:DATA_ROOT/p:PATH/l:LANG");
    vi.stubEnv("LANG", "en_US.UTF-8");
    const env = wslLauncherEnvironment({ ...process.env, APP_MODE: "test", NODE_ENV: "test" });
    expect(env).not.toHaveProperty("SYNAX_RUNTIME_SIDECAR_TOKEN");
    expect(env).not.toHaveProperty("DATA_ROOT");
    expect(env.WSLENV).not.toContain("SYNAX_RUNTIME_");
    expect(env.WSLENV).not.toContain("DATA_ROOT");
    expect(env.WSLENV).toContain("APP_MODE");
    expect(env.WSLENV).toContain("LANG");
    expect(env.NODE_ENV).toBe("test");
  });
});
