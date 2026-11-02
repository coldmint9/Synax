import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { parseArgs } from "./args.js";
import { ensureRuntime } from "./runtime-host.js";
import { HttpRuntimeClient } from "../services/local-node/modules/agent-runtime/runtime-client.js";

let home: string;
function writeToken(root: string, token: string) {
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, "runtime-access-token"), token);
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), "synax-runtime-home-"));
  vi.spyOn(os, "homedir").mockReturnValue(home);
  for (const key of ["DATA_ROOT", "SYNAX_API", "SYNAX_RUNTIME_TOKEN", "SYNAX_RUNTIME_TOKEN_FILE", "PORT"])
    vi.stubEnv(key, undefined);
  writeToken(path.join(home, ".synax", "v2"), "synax-secret");
});
afterEach(() => {
  vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.unstubAllGlobals();
  fs.rmSync(home, { recursive: true, force: true });
});

it.each([false, true])("uses the same Synax token for CLI discovery and API requests (override=%s)", async (override) => {
  const root = override ? path.join(home, "custom") : path.join(home, ".synax", "v2");
  if (override) vi.stubEnv("DATA_ROOT", root);
  writeToken(root, "synax-secret");
  const fetch = vi.fn(async (_url: unknown, options?: RequestInit) => {
    expect(new Headers(options?.headers).get("Authorization")).toBe("Bearer synax-secret");
    return Response.json({ protocol: "synax.runtime.v1" });
  });
  vi.stubGlobal("fetch", fetch);
  expect(await ensureRuntime(parseArgs([]))).toMatchObject({
    managed: false, tokenFile: path.join(root, "runtime-access-token"),
  });
  await new HttpRuntimeClient({ fetch }).getRun("session", "run");
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(fs.readFileSync(path.join(home, ".synax", "v2", "runtime-access-token"), "utf8"))
    .toBe("synax-secret");
});

it("does not fall back to a Synax token when the Synax profile is empty", async () => {
  const fetch = vi.fn(async (_url: unknown, options?: RequestInit) => {
    expect(new Headers(options?.headers).get("Authorization")).toBeNull();
    return Response.json({ id: "run" });
  });
  await new HttpRuntimeClient({ fetch }).getRun("session", "run");
  expect(fs.existsSync(path.join(home, ".synax"))).toBe(false);
});
