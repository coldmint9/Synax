import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';

const command = process.argv[2];
if (!command) {
  console.error('usage: node scripts/runtime-sidecar-cargo.mjs <check|test|build> [cargo args]');
  process.exit(2);
}

const env = { ...process.env };
if (process.platform === 'darwin' && !env.LIBCLANG_PATH) {
  const candidates = [
    '/opt/homebrew/opt/llvm/lib',
    '/usr/local/opt/llvm/lib',
    '/Library/Developer/CommandLineTools/usr/lib',
    '/Applications/Xcode.app/Contents/Developer/Toolchains/XcodeDefault.xctoolchain/usr/lib',
  ];
  const libclang = candidates.find(path => existsSync(join(path, 'libclang.dylib')));
  if (libclang) {
    env.LIBCLANG_PATH = libclang;
    // Keep rustc's own LLVM isolated. DYLD_LIBRARY_PATH can make rustc load
    // Homebrew LLVM and crash; libclang's transitive dependencies are found
    // through the fallback path without replacing the compiler's runtime.
    env.DYLD_FALLBACK_LIBRARY_PATH = [libclang, env.DYLD_FALLBACK_LIBRARY_PATH].filter(Boolean).join(':');
  }
}

const result = spawnSync(
  'cargo',
  [command, ...process.argv.slice(3), '--manifest-path', 'runtime-sidecar/Cargo.toml'],
  { stdio: 'inherit', env },
);
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
