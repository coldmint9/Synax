const fs = require("node:fs/promises");
const path = require("node:path");

// A missing platform is allowed; a platform with only some of its files is not.
module.exports = async function collectDesktopAssets(root) {
  const { version } = JSON.parse(
    await fs.readFile(path.join(root, "package.json"), "utf8"),
  );
  const assets = new Map();
  async function collect(directory) {
    for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) await collect(file);
      else if (entry.isFile()) {
        if (assets.has(entry.name))
          throw new Error(`Duplicate desktop asset: ${entry.name}`);
        assets.set(entry.name, file);
      }
    }
  }
  const directory = path.join(root, "release-assets");
  try {
    await fs.access(directory);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return { version, assets, targets: [] };
  }
  await collect(directory);
  const targets = [];
  const recognized = new Set();
  for (const name of ["darwin-x64", "darwin-arm64", "win32-x64", "linux-x64"]) {
    const names = [`Synax-${version}-${name}.zip`];
    if (name.startsWith("darwin")) names.push(`Synax-${version}-${name}.dmg`);
    if (name.startsWith("win32"))
      names.push(
        `Synax-${version}-${name}-Setup.exe`,
        `Synax-${version}-full.nupkg`,
        "RELEASES",
      );
    if (!name.startsWith("linux")) names.push(`desktop-${name}.json`);
    for (const asset of names) recognized.add(asset);
    if (!names.some((asset) => assets.has(asset))) continue;
    for (const asset of names) {
      if (!assets.has(asset))
        throw new Error(`Missing desktop asset: ${asset}`);
    }
    targets.push({ name, names });
  }
  for (const name of assets.keys()) {
    if (!recognized.has(name))
      throw new Error(`Unexpected desktop asset: ${name}`);
  }
  return { version, assets, targets };
};
