import { execFile } from "node:child_process";
import path from "node:path";
import { PRODUCT_NAME } from "./update-source.js";

// Paths travel as environment data, never interpolated PowerShell source. Do not
// execute the downloaded installer to inspect it. NSIS stubs are x86 even for
// x64/arm64 payloads, so the stub's PE machine field is not a payload arch check.
const metadataScript = String.raw`
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$item = Get-Item -LiteralPath $env:SYNAX_INSTALLER_PATH -ErrorAction Stop
if ($item.PSIsContainer) { throw 'Installer path is not a file' }
$info = $item.VersionInfo
@{ productName = [string]$info.ProductName; productVersion = [string]$info.ProductVersion } | ConvertTo-Json -Compress
`;

export async function readWindowsInstallerMetadata(file: string): Promise<unknown> {
  const executable = path.win32.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const stdout = await new Promise<string>((resolve, reject) => {
    execFile(executable, ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", Buffer.from(metadataScript, "utf16le").toString("base64")], {
      env: { ...process.env, SYNAX_INSTALLER_PATH: file },
      windowsHide: true, timeout: 30_000, maxBuffer: 64 * 1024, encoding: "utf8",
    }, (error, stdout) => error ? reject(error) : resolve(stdout));
  });
  return JSON.parse(stdout.replace(/^\uFEFF/, "").trim());
}

/** Check the actual version resource, in addition to feed hashes and Authenticode. */
export async function verifyWindowsInstaller(
  file: string, version: string, arch: string,
  readMetadata = readWindowsInstallerMetadata,
): Promise<void> {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !["x64", "arm64"].includes(arch))
    throw new Error("更新包 Windows 目标版本或架构无效。");
  const value = await readMetadata(file) as { productName?: unknown; productVersion?: unknown } | null;
  if (value?.productName !== PRODUCT_NAME ||
    ![version, `${version}.0`].includes(value?.productVersion as string))
    throw new Error("更新包 Windows 产品身份或版本不匹配：仅允许 Synax 安装包。");
}
