import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

export interface WindowsSigningConfig {
  publisher: string;
  pfxPath: string;
  password: string;
}

const root = fileURLToPath(new URL("..", import.meta.url));
// Identity must survive `out/` cleanup and be reused for every release.
const signingDirectory = path.join(root, ".signing", "windows");
const metadataPath = path.join(signingDirectory, "config.json");
const certificatePath = path.join(signingDirectory, "Synax.pfx");
export const publicCertificatePath = path.join(signingDirectory, "Synax.cer");
export const installerIncludePath = path.join(signingDirectory, "installer-signing.nsh");
const script = fileURLToPath(new URL("./create-windows-self-signed-cert.ps1", import.meta.url));

function apply(config: WindowsSigningConfig): WindowsSigningConfig {
  process.env.SYNAX_WINDOWS_PUBLISHER = config.publisher;
  process.env.CSC_LINK = config.pfxPath;
  process.env.CSC_KEY_PASSWORD = config.password;
  process.env.WINDOWS_CERTIFICATE_PASSWORD = config.password;
  return config;
}

export function signingInputs(env: NodeJS.ProcessEnv): WindowsSigningConfig | null {
  const publisher = env.SYNAX_WINDOWS_PUBLISHER?.trim();
  const pfxPath = env.CSC_LINK;
  const password = env.CSC_KEY_PASSWORD;
  if (!publisher && !pfxPath && !password) return null;
  if (!publisher || !pfxPath || !password)
    throw new Error("Windows signing requires CSC_LINK, CSC_KEY_PASSWORD, and SYNAX_WINDOWS_PUBLISHER together.");
  return { publisher, pfxPath, password };
}

function storedConfig(): WindowsSigningConfig | null {
  if (!existsSync(metadataPath)) return null;
  const data: unknown = JSON.parse(readFileSync(metadataPath, "utf8"));
  if (!data || typeof data !== "object") throw new Error("Invalid Windows signing configuration.");
  const config = data as WindowsSigningConfig;
  if (typeof config.publisher !== "string" || !config.publisher ||
      typeof config.pfxPath !== "string" || !path.isAbsolute(config.pfxPath) ||
      typeof config.password !== "string" || !config.password || !existsSync(config.pfxPath))
    throw new Error("Windows signing identity is incomplete; restore the original PFX instead of generating another identity.");
  return config;
}

/** Read-only loading: importing Forge configuration must never generate keys. */
export function ensureWindowsSigning(): WindowsSigningConfig | null {
  if (process.platform !== "win32") return null;
  const config = signingInputs(process.env) ?? storedConfig();
  if (config) {
    if (!existsSync(config.pfxPath))
      throw new Error("Run npm run prepare:windows-signing to materialize CSC_LINK before packaging.");
    return apply(config);
  }
  if (process.env.SYNAX_REQUIRE_SIGNED_UPDATES === "1")
    throw new Error("A stable Windows release requires the persistent signing PFX. Configure the Windows signing secrets.");
  return null;
}

export function prepareWindowsSigning(): WindowsSigningConfig | null {
  if (process.platform !== "win32") return null;
  const supplied = signingInputs(process.env);
  let config = supplied ?? storedConfig();
  // Fork PRs cannot access signing secrets. Never replace a release identity with
  // a fresh throwaway key on an ephemeral CI runner.
  if (!config && process.env.CI) {
    if (process.env.SYNAX_REQUIRE_SIGNED_UPDATES === "1")
      throw new Error("Stable Windows release requires SYNAX_WINDOWS_CSC_LINK, SYNAX_WINDOWS_CSC_KEY_PASSWORD and SYNAX_WINDOWS_PUBLISHER.");
    console.log("Windows preview: signing secrets unavailable; producing unsigned manual-test artifacts.");
    return null;
  }
  mkdirSync(signingDirectory, { recursive: true, mode: 0o700 });
  if (!config) {
    if (existsSync(certificatePath))
      throw new Error("Existing PFX has no configuration. Restore its password; refusing to replace the signing identity.");
    config = { publisher: "Synax Self-Signed Publisher", pfxPath: certificatePath, password: randomBytes(32).toString("base64") };
  } else if (supplied && !existsSync(config.pfxPath)) {
    // GitHub Secrets can hold the base64 PFX. Do not fetch certificate URLs.
    const encoded = config.pfxPath.replace(/\s/g, "");
    if (!/^[A-Za-z0-9+/]+={0,2}$/.test(encoded) || encoded.length < 100)
      throw new Error("CSC_LINK must be an existing local PFX path or its base64 contents.");
    writeFileSync(certificatePath, Buffer.from(encoded, "base64"), { mode: 0o600 });
    config = { ...config, pfxPath: certificatePath };
  } else {
    config = { ...config, pfxPath: path.resolve(config.pfxPath) };
  }
  // Password stays out of process arguments and error/log output.
  const result = execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-File", script], {
    encoding: "utf8",
    env: { ...process.env, SYNAX_SIGNING_PFX: config.pfxPath, SYNAX_SIGNING_CER: publicCertificatePath,
      SYNAX_SIGNING_PASSWORD: config.password, SYNAX_SIGNING_PUBLISHER: config.publisher },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const identity = JSON.parse(result.trim()) as { publisher: string; thumbprint: string };
  if (!identity.publisher || !/^[A-Fa-f0-9]{40}$/.test(identity.thumbprint))
    throw new Error("Certificate preparation did not return a valid signing identity.");
  config.publisher = identity.publisher;
  writeFileSync(metadataPath, JSON.stringify(config), { mode: 0o600 });
  writeFileSync(installerIncludePath, [
    "!macro customInstall",
    `  File /oname=$PLUGINSDIR\\Synax-Windows-Signing.cer "${publicCertificatePath.replace(/\\/g, "/")}"`,
    "  nsExec::ExecToLog '\"$SYSDIR\\certutil.exe\" -user -addstore -f TrustedPublisher \"$PLUGINSDIR\\Synax-Windows-Signing.cer\"'",
    "!macroend",
    "!macro customUnInstall",
    `  nsExec::ExecToLog '\"$SYSDIR\\certutil.exe\" -user -delstore TrustedPublisher \"${identity.thumbprint}\"'`,
    "!macroend",
    "",
  ].join("\r\n"), { mode: 0o600 });
  console.log(`Windows signing identity prepared: ${identity.publisher}; thumbprint ${identity.thumbprint}`);
  return apply(config);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  prepareWindowsSigning();
