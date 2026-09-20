import fs from "node:fs/promises";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { compareVersions } from "../electron/lib/ui-update-format.js";
import { findUiRelease } from "../electron/lib/ui-update-feed.js";
import { createUiReleaseArtifacts } from "./ui-release-artifacts.js";

const tag = process.env.GITHUB_REF_NAME ?? "";
if (!/^ui-v\d+\.\d+\.\d+$/.test(tag))
  throw new Error("Release tag must be ui-vMAJOR.MINOR.PATCH");
const version = tag.slice(4);
const appVersion = JSON.parse(await fs.readFile("package.json", "utf8"))
  .version as string;
const baseTag = `v${appVersion}`;
// A UI-only release must be built against the exact code of a published shell.
const changed = execFileSync("git", ["diff", "--name-only", baseTag, "HEAD"], {
  encoding: "utf8",
})
  .trim()
  .split("\n")
  .filter(Boolean);
const permitted =
  /^(web\/|docs\/|README(?:\.zh-CN)?\.md$|package-lock\.json$|\.github\/workflows\/build-ui-release\.yml$|scripts\/(?:build-ui-release|ui-release-artifacts)\.ts$)/;
const unsafe = changed.filter((file) => !permitted.test(file));
if (unsafe.length)
  throw new Error(
    `UI-only release changes desktop/backend files: ${unsafe.join(", ")}`,
  );

const previous = await findUiRelease(appVersion, null, []);
if (previous && compareVersions(previous.manifest.version, version) >= 0) {
  throw new Error(
    "UI release version must be newer than the existing compatible release",
  );
}
const artifacts = await createUiReleaseArtifacts(
  path.resolve("web/dist"),
  version,
  appVersion,
  previous?.manifest,
);
const output = path.resolve("out/ui-release");
await fs.mkdir(output, { recursive: true });
await fs.writeFile(
  path.join(output, "ui-manifest.json"),
  JSON.stringify(artifacts.manifest, null, 2),
);
await fs.writeFile(path.join(output, "ui-full.json.gz"), artifacts.full);
if (artifacts.delta)
  await fs.writeFile(path.join(output, "ui-delta.json.gz"), artifacts.delta);
console.log(
  `UI ${version} for desktop ${appVersion}; full ${artifacts.full.length} bytes, delta ${artifacts.delta?.length ?? "initial release"}`,
);
