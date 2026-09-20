const fs = require("node:fs/promises");
const collectDesktopAssets = require("./desktop-publish-assets.cjs");

/** Publish the platforms that passed their build and checks. */
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

  const { version, assets, targets } = await collectDesktopAssets(root);
  if (!targets.length) {
    core.notice(
      "No successful desktop artifacts; keeping the existing preview.",
    );
    return;
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
      `Available platforms: ${targets.map((target) => target.name).join(", ")}`,
      "",
      "此通道随 main 推送更新，供手动安装测试；正式版自动更新不会选择预发布版本。",
      "This rolling preview is for manual testing. Stable automatic updates exclude prereleases.",
    ].join("\n"),
    prerelease: true,
    make_latest: "false",
  };
  // Hide the release until all available platforms belong to the same build. A failed
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
