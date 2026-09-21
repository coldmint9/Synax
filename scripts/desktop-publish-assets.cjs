const fs = require("node:fs/promises");
const path = require("node:path");
const { createHash } = require("node:crypto");

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
    if (!name.startsWith("linux")) {
      const manifestName = `desktop-${name}.json`;
      const blockMapName = name.startsWith("darwin")
        ? `Synax-${version}-${name}.zip.blockmap`
        : `Synax-${version}-full.nupkg.blockmap`;
      names.push(manifestName);
      recognized.add(blockMapName);
      const manifestFile = assets.get(manifestName);
      if (manifestFile) {
        const manifest = JSON.parse(await fs.readFile(manifestFile, "utf8"));
        if (manifest?.blockMap) {
          const map = manifest.blockMap;
          if (
            map.name !== blockMapName ||
            !Number.isSafeInteger(map.size) ||
            map.size <= 0 ||
            map.size > 8 * 1024 ** 2 ||
            !/^[a-f0-9]{64}$/.test(map.sha256)
          )
            throw new Error(
              `Invalid desktop blockmap metadata: ${manifestName}`,
            );
          const file = assets.get(blockMapName);
          if (!file) throw new Error(`Missing desktop asset: ${blockMapName}`);
          if (
            (await fs.stat(file)).size !== map.size ||
            createHash("sha256")
              .update(await fs.readFile(file))
              .digest("hex") !== map.sha256
          )
            throw new Error(
              `Desktop blockmap does not match manifest: ${blockMapName}`,
            );
          names.push(blockMapName);
        } else if (assets.has(blockMapName))
          throw new Error(`Unreferenced desktop blockmap: ${blockMapName}`);
      } else if (assets.has(blockMapName)) names.push(blockMapName);
    }
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
