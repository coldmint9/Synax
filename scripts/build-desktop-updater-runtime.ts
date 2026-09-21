import fs from "node:fs/promises";
import path from "node:path";
import { build } from "tsup";
import { parseUpdatePublicKey } from "../electron/lib/desktop-update-signing.js";

const publicKey = process.env.SYNAX_UPDATE_PUBLIC_KEY?.trim() ?? "";
if (publicKey) parseUpdatePublicKey(publicKey);
await build({
  entry: [
    "electron/lib/desktop-differential-engine.ts",
    "electron/lib/desktop-zip-engine.ts",
  ],
  outDir: "dist-electron/lib",
  format: ["esm"],
  platform: "node",
  target: "node22",
  config: false,
  noExternal: [/.*/],
  clean: false,
  dts: false,
  splitting: false,
  banner: {
    js: 'import { createRequire } from "node:module"; const require = createRequire(import.meta.url);',
  },
});
await fs.mkdir("dist-electron", { recursive: true });
await fs.writeFile(
  path.join("dist-electron", "update-public-key.json"),
  JSON.stringify({ publicKey }),
);
// The bundled planner is MIT licensed; retain its upstream notice in shipped apps.
await fs.copyFile(
  "node_modules/electron-updater/LICENSE",
  "dist-electron/lib/electron-updater-LICENSE",
);
for (const dependency of ["yauzl", "pend"])
  await fs.copyFile(
    `node_modules/${dependency}/LICENSE`,
    `dist-electron/lib/${dependency}-LICENSE`,
  );
console.log(
  publicKey
    ? "Desktop differential updates: signed manifests required"
    : "Desktop updates: unsigned full-download compatibility mode (no public key configured)",
);
