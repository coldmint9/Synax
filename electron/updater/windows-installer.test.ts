import { afterEach, expect, it, vi } from "vitest";
const execFile = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", () => ({ execFile }));
import { readWindowsInstallerMetadata, verifyWindowsInstaller } from "./windows-installer.js";
afterEach(() => { vi.clearAllMocks(); vi.unstubAllEnvs(); });

it.each(["0.2.0", "0.2.0.0"])("accepts the exact Synax product at Windows version %s", async (productVersion) => {
  const read = vi.fn(async () => ({ productName: "Synax", productVersion }));
  await expect(verifyWindowsInstaller("installer.exe", "0.2.0", "x64", read)).resolves.toBeUndefined();
  expect(read).toHaveBeenCalledWith("installer.exe");
});
it.each([
  { productName: "Synax", productVersion: "0.2.0" },
  { productName: "Synax", productVersion: "0.2.1" },
  { productName: "Synax", productVersion: "0.2.0-malicious" },
  {}, null,
])("rejects foreign, wrong-version or missing metadata even under a Synax filename %#", async (value) => {
  await expect(verifyWindowsInstaller("Synax-0.2.0-win32-x64-NSIS.exe", "0.2.0", "x64", async () => value)).rejects.toThrow("身份或版本不匹配");
});
it("does not execute the installer or interpolate a hostile path into PowerShell", async () => {
  execFile.mockImplementation((_exe, _args, _options, done) => done(null, '\ufeff{"productName":"Synax","productVersion":"0.2.0"}\r\n'));
  const file = "C:\\Downloads\\a'; Start-Process calc; #.exe";
  await expect(readWindowsInstallerMetadata(file)).resolves.toMatchObject({ productName: "Synax" });
  const [exe, args, options] = execFile.mock.calls[0];
  expect(exe).toMatch(/WindowsPowerShell\\v1\.0\\powershell\.exe$/);
  expect(args).toContain("-EncodedCommand");
  const script = Buffer.from(args.at(-1), "base64").toString("utf16le");
  expect(script).toContain("Get-Item -LiteralPath $env:SYNAX_INSTALLER_PATH");
  expect(script).not.toContain(file);
  expect(script).not.toContain("Start-Process");
  expect(options.env.SYNAX_INSTALLER_PATH).toBe(file);
  expect(options.timeout).toBe(30_000);
});
it("fails closed when metadata inspection fails", async () => {
  execFile.mockImplementation((_exe, _args, _options, done) => done(new Error("unreadable"), ""));
  await expect(verifyWindowsInstaller("installer.exe", "0.2.0", "x64")).rejects.toThrow("unreadable");
});
