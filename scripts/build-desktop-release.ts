import fs from "node:fs/promises";
import path from "node:path";
import { createDesktopReleaseArtifacts } from "./desktop-release-artifacts.js";

const version = JSON.parse(await fs.readFile("package.json", "utf8"))
  .version as string;
const tag = process.env.GITHUB_REF_NAME;
if (process.env.GITHUB_REF_TYPE === "tag" && tag !== `v${version}`)
  throw new Error(
    `Desktop tag ${tag} must match package.json version v${version}`,
  );
if (
  (process.platform !== "darwin" && process.platform !== "win32") ||
  (process.arch !== "arm64" && process.arch !== "x64")
)
  throw new Error(
    "Desktop online updates support macOS and Windows on arm64/x64",
  );
const output = path.resolve("out/desktop-release");
await fs.rm(output, { recursive: true, force: true });
const manifest = await createDesktopReleaseArtifacts(
  path.resolve("out/make"),
  output,
  version,
  process.platform,
  process.arch,
);
console.log(
  `Desktop ${version} (${manifest.platform}/${manifest.arch}): ${manifest.artifact.name}, ${manifest.artifact.size} bytes`,
);
