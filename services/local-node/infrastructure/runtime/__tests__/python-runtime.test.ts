import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { pythonRuntimeBinary, resolvePythonRuntime } from "../python-runtime.js";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function root() { const dir = fs.mkdtempSync(path.join(os.tmpdir(), "synax-python-resolver-")); roots.push(dir); return dir; }
function executable(file: string) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, "fixture"); fs.chmodSync(file, 0o755); return fs.realpathSync(file); }

describe("Python runtime resolution", () => {
  it("prefers an explicit runtime over resources and development PATH", () => {
    const dir = root(); const configured = executable(path.join(dir, "explicit-python"));
    executable(path.join(dir, "python3"));
    expect(resolvePythonRuntime({ env: { SYNAX_PYTHON_RUNTIME: configured, PATH: dir }, resourcesPath: dir })).toBe(configured);
  });
  it.each(["darwin", "linux", "win32"] as const)("resolves packaged %s layouts without PATH fallback", platform => {
    const dir = root(); const binary = executable(pythonRuntimeBinary(path.join(dir, "python-runtime"), platform, "x64"));
    expect(resolvePythonRuntime({ env: { NODE_ENV: "production" }, resourcesPath: dir, platform, arch: "x64" })).toBe(binary);
    fs.rmSync(binary);
    executable(path.join(dir, platform === "win32" ? "python3.exe" : "python3"));
    expect(resolvePythonRuntime({ env: { NODE_ENV: "production", PATH: dir }, resourcesPath: dir, platform, arch: "x64" })).toBeUndefined();
  });
  it("uses a development PATH interpreter and rejects missing/non-executable candidates", () => {
    const dir = root(); const binary = executable(path.join(dir, "python3"));
    expect(resolvePythonRuntime({ env: { NODE_ENV: "development", PATH: dir }, platform: "linux" })).toBe(binary);
    if (process.platform !== "win32") { fs.chmodSync(binary, 0o644); expect(resolvePythonRuntime({ env: { PATH: dir }, platform: "linux" })).toBeUndefined(); }
    expect(resolvePythonRuntime({ env: { PATH: "", SYNAX_PYTHON_RUNTIME: path.join(dir, "missing") } })).toBeUndefined();
  });
});
