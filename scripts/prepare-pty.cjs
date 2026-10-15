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

// npm can also lose executable bits on package-provided Unix CLI entrypoints.
// Repair only bin targets with a shebang so commands such as electron-forge
// remain runnable after a fresh install on macOS/Linux.
if (process.platform !== 'win32') {
  const binDirectory = path.join(process.cwd(), 'node_modules', '.bin');
  if (fs.existsSync(binDirectory)) {
    for (const entry of fs.readdirSync(binDirectory)) {
      const link = path.join(binDirectory, entry);
      let target;
      try {
        target = fs.realpathSync(link);
      } catch {
        continue;
      }

      let source;
      try {
        source = fs.readFileSync(target, 'utf8');
      } catch {
        continue;
      }

      if (!source.startsWith('#!')) continue;
      const mode = fs.statSync(target).mode;
      if ((mode & 0o111) === 0) fs.chmodSync(target, mode | 0o111);
    }
  }
}
