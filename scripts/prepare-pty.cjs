// npm's node-pty macOS prebuild can lose the helper's executable bits.
// Repair only the installed dependency's helper; packaging preserves its mode.
const fs = require('node:fs');
const path = require('node:path');
if (process.platform === 'darwin') {
  const root = path.dirname(require.resolve('node-pty/package.json'));
  for (const relative of [`prebuilds/darwin-${process.arch}/spawn-helper`, 'build/Release/spawn-helper']) {
    const file = path.join(root, relative);
    if (fs.existsSync(file)) fs.chmodSync(file, fs.statSync(file).mode | 0o111);
  }
}
