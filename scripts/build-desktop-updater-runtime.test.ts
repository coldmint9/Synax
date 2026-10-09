import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const run = promisify(execFile);
const root = fileURLToPath(new URL("..", import.meta.url));

it("builds updater constructors against the host Electron API instead of the npm launcher", async () => {
  // Exercise the production build configuration, not an unbundled TS import.
  await run(process.execPath, [
    path.join(root, "node_modules/tsx/dist/cli.mjs"),
    "scripts/build-desktop-updater-runtime.ts",
  ], { cwd: root });
  const bundle = path.join(root, "dist-electron/lib/desktop-updater-engine.js");
  expect(await readFile(bundle, "utf8")).not.toContain("node_modules/electron/index.js");
  const { stdout } = await run(process.execPath, ["--input-type=module", "-e", `
    import assert from 'node:assert/strict';
    import Module from 'node:module';
    import { EventEmitter } from 'node:events';
    import { pathToFileURL } from 'node:url';
    const originalLoad = Module._load;
    let reads = 0;
    const host = {
      app: { getVersion() { reads++; return '1.12.1'; } },
      autoUpdater: new EventEmitter(),
    };
    Module._load = function(id, ...args) {
      if (id === 'electron') return host;
      return originalLoad.call(this, id, ...args);
    };
    const engine = await import(pathToFileURL(process.argv[1]).href);
    for (const platform of ['darwin', 'win32']) {
      const updater = engine.createFrameworkUpdater(platform);
      assert.equal(updater.currentVersion.version, '1.12.1');
      engine.configureFrameworkFeed(updater, platform, 'x64', null);
      assert.equal(updater.autoInstallOnAppQuit, false);
    }
    assert.equal(reads, 2);
    let provider;
    let requests = [];
    let failure = 'ERR_UPDATER_CHANNEL_FILE_NOT_FOUND';
    let latest = 'v1.6.6';
    const client = {
      currentVersion: { version: '1.12.1' },
      setFeedURL(options) {
        provider = new options.updateProvider(options, client, {
          platform: 'darwin', isUseMultipleRangeRequest: false,
          executor: { async request(options) {
            requests.push(options);
            if (options.path.includes('.yml')) throw Object.assign(new Error('feed missing'), { code: failure });
            return JSON.stringify({ tag_name: latest, draft: false, prerelease: false });
          } },
        });
      },
    };
    engine.configureFrameworkFeed(client, 'darwin', 'arm64', 'https://proxy.example/');
    assert.equal((await provider.getLatestVersion()).version, '1.12.1');
    assert.equal(requests.length, 2);
    assert.equal(requests[1].hostname, 'proxy.example');
    assert.ok(requests[1].path.includes('api.github.com/repos/coldmint9/Synax/releases/latest'));
    latest = 'v1.13.0';
    await assert.rejects(provider.getLatestVersion(), /更新清单尚未就绪/);
    failure = 'ETIMEDOUT';
    requests = [];
    await assert.rejects(provider.getLatestVersion(), /feed missing/);
    assert.equal(requests.length, 1);
    console.log('host Electron constructors OK');
  `, bundle], { cwd: root });
  expect(stdout).toContain("host Electron constructors OK");
}, 60_000);
