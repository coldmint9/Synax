import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import forgeConfig from "../forge.config.js";

const root = fileURLToPath(new URL("../", import.meta.url));
const instructionPath = path.join(root, "scripts/dmg/安装说明.txt");
const commandPath = path.join(root, "scripts/dmg/安装后运行.command");

describe("macOS DMG install help", () => {
  it("puts instructions and a manual post-install command alongside the app shortcut", () => {
    const maker = forgeConfig.makers?.find(
      (item) => "name" in item && item.name === "@electron-forge/maker-dmg",
    );
    expect(maker && "config" in maker).toBe(true);
    if (!maker || !("config" in maker)) return;
    const config = maker.config("arm64");
    const appPath = "/tmp/Synax.app";
    const contents = config.contents({ appPath, name: "Synax" });
    expect(contents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "file", path: appPath }),
        expect.objectContaining({ type: "link", path: "/Applications" }),
        expect.objectContaining({ type: "file", path: instructionPath }),
        expect.objectContaining({ type: "file", path: commandPath }),
      ]),
    );
  });

  it("explains the installation order and has an executable command that only targets the installed app", () => {
    const instructions = fs.readFileSync(instructionPath, "utf8");
    expect(instructions).toContain("先");
    expect(instructions).toContain("/Applications/Synax.app");
    expect(instructions).toContain("安装后运行.command");
    expect(fs.statSync(commandPath).mode & 0o111).not.toBe(0);
    execFileSync("bash", ["-n", commandPath]);
    const command = fs.readFileSync(commandPath, "utf8");
    expect(command).toContain('if [[ ! -d "/Applications/Synax.app" ]]');
    expect(command).toContain(
      "sudo xattr -rd com.apple.quarantine /Applications/Synax.app",
    );
  });
});
