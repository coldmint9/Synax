const fs = require("node:fs/promises");
const { createHash } = require("node:crypto");
const collectDesktopAssets = require("./desktop-publish-assets.cjs");

module.exports = async function publishDesktopRelease(
  { github, context, core },
  root = process.cwd(),
) {
  const { version, assets, targets } = await collectDesktopAssets(root);
  const tag = `v${version}`;
  if (context.ref !== `refs/tags/${tag}`)
    throw new Error(`Desktop release must use the package version tag ${tag}.`);
  if (!targets.length) {
    core.notice("No successful desktop artifacts; nothing to publish.");
    return;
  }
  const repo = context.repo;
  let release;
  try {
    ({ data: release } = await github.rest.repos.getReleaseByTag({
      ...repo,
      tag,
    }));
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  const previousAssets = release
    ? await github.paginate(github.rest.repos.listReleaseAssets, {
        ...repo,
        release_id: release.id,
        per_page: 100,
      })
    : [];
  const previous = new Map(previousAssets.map((asset) => [asset.name, asset]));
  const pending = new Map(assets);
  for (const target of targets) {
    if (!release?.draft && target.names.every((name) => previous.has(name))) {
      // A rerun may produce different archive bytes. Leave complete, already
      // published platforms untouched while adding platforms that were missing.
      for (const name of target.names) pending.delete(name);
      core.notice(`Keeping published platform ${target.name}.`);
    }
  }
  // A prior upload may have failed between its binaries and manifest. Resume
  // only if those existing binaries match the ones described by this build.
  for (const [name, file] of pending) {
    const existing = previous.get(name);
    if (!existing || release.draft) continue;
    const digest = `sha256:${createHash("sha256")
      .update(await fs.readFile(file))
      .digest("hex")}`;
    if (existing.digest !== digest)
      throw new Error(
        `Published asset ${name} differs from this build; use a new version.`,
      );
    pending.delete(name);
  }
  if (!release) {
    ({ data: release } = await github.rest.repos.createRelease({
      ...repo,
      tag_name: tag,
      target_commitish: context.sha,
      name: `Synax ${tag}`,
      draft: true,
    }));
  }
  // On public releases, metadata is the update client's visibility boundary.
  // Upload installers first, and expose their manifests only after they exist.
  const ordered = [...pending].sort(
    ([a], [b]) =>
      Number(a.startsWith("desktop-")) - Number(b.startsWith("desktop-")),
  );
  for (const [name, file] of ordered) {
    if (previous.has(name)) {
      await github.rest.repos.deleteReleaseAsset({
        ...repo,
        asset_id: previous.get(name).id,
      });
    }
    const data = await fs.readFile(file);
    await github.rest.repos.uploadReleaseAsset({
      ...repo,
      release_id: release.id,
      name,
      data,
      headers: {
        "content-type": "application/octet-stream",
        "content-length": data.length,
      },
    });
  }
  if (release.draft) {
    await github.rest.repos.updateRelease({
      ...repo,
      release_id: release.id,
      draft: false,
      make_latest: "true",
    });
  }
  core.notice(
    `Published desktop artifacts: ${context.serverUrl}/${repo.owner}/${repo.repo}/releases/tag/${tag}`,
  );
};
