const fs = require("node:fs/promises");
const path = require("node:path");

/** Called by github-script after every platform has uploaded its artifacts. */
module.exports = async function publishPreview(
  { github, context, core },
  root = process.cwd(),
) {
  if (context.ref !== "refs/heads/main")
    throw new Error("Preview builds must come from main.");
  const repo = context.repo;
  const { data: head } = await github.rest.git.getRef({
    ...repo,
    ref: "heads/main",
  });
  if (head.object.sha !== context.sha) {
    core.notice("Skipping preview publication: main has a newer commit.");
    return;
  }

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
          throw new Error(`Duplicate preview asset: ${entry.name}`);
        assets.set(entry.name, file);
      }
    }
  }
  await collect(path.join(root, "release-assets"));
  const required = [
    `Synax-${version}-darwin-x64.dmg`,
    `Synax-${version}-darwin-arm64.dmg`,
    `Synax-${version}-win32-x64-Setup.exe`,
    ...["darwin-x64", "darwin-arm64", "win32-x64", "linux-x64"].map(
      (target) => `Synax-${version}-${target}.zip`,
    ),
    ...["darwin-x64", "darwin-arm64", "win32-x64"].map(
      (target) => `desktop-${target}.json`,
    ),
  ];
  for (const name of required) {
    if (!assets.has(name)) throw new Error(`Missing preview asset: ${name}`);
  }

  let release;
  try {
    ({ data: release } = await github.rest.repos.getReleaseByTag({
      ...repo,
      tag: "preview",
    }));
  } catch (error) {
    if (error.status !== 404) throw error;
  }
  if (release && !release.prerelease)
    throw new Error("Refusing to replace a non-preview release.");
  const runUrl = `${context.serverUrl}/${repo.owner}/${repo.repo}/actions/runs/${context.runId}`;
  const metadata = {
    ...repo,
    tag_name: "preview",
    target_commitish: context.sha,
    name: "Synax — Latest Preview",
    body: [
      "最新 main 预览构建 / Latest preview build from main.",
      "",
      `Base version: ${version}`,
      `Commit: ${context.sha}`,
      `Build: [#${context.runNumber}](${runUrl})`,
      "",
      "此通道随 main 推送更新，供手动安装测试；正式版自动更新不会选择预发布版本。",
      "This rolling preview is for manual testing. Stable automatic updates exclude prereleases.",
    ].join("\n"),
    prerelease: true,
    make_latest: "false",
  };
  // Hide the release until all platforms belong to the same build. A failed
  // upload leaves a draft that the next successful run can safely replace.
  if (release) {
    await github.rest.repos.updateRelease({
      ...metadata,
      release_id: release.id,
      draft: true,
    });
    const previousAssets = await github.paginate(
      github.rest.repos.listReleaseAssets,
      {
        ...repo,
        release_id: release.id,
        per_page: 100,
      },
    );
    for (const asset of previousAssets)
      await github.rest.repos.deleteReleaseAsset({
        ...repo,
        asset_id: asset.id,
      });
  } else {
    ({ data: release } = await github.rest.repos.createRelease({
      ...metadata,
      draft: true,
    }));
  }
  for (const [name, file] of assets) {
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
  // Updating a release's target_commitish does not move an existing tag.
  try {
    await github.rest.git.getRef({ ...repo, ref: "tags/preview" });
    await github.rest.git.updateRef({
      ...repo,
      ref: "tags/preview",
      sha: context.sha,
      force: true,
    });
  } catch (error) {
    if (error.status !== 404) throw error;
    await github.rest.git.createRef({
      ...repo,
      ref: "refs/tags/preview",
      sha: context.sha,
    });
  }
  await github.rest.repos.updateRelease({
    ...metadata,
    release_id: release.id,
    draft: false,
  });
  core.notice(
    `Published preview for ${context.sha}: ${context.serverUrl}/${repo.owner}/${repo.repo}/releases/tag/preview`,
  );
};
