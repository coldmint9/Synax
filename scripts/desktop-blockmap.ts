import fs from "node:fs/promises";
import { constants } from "node:fs";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { appBuilderPath } from "app-builder-bin";
import {
  hashFile,
  MAX_BLOCK_MAP_SIZE,
  type DesktopArtifact,
} from "../electron/lib/desktop-update-format.js";
import path from "node:path";

const run = promisify(execFile);
export async function createDesktopBlockMap(
  source: string,
  output: string,
): Promise<DesktopArtifact> {
  if (process.platform !== "win32") {
    try {
      await fs.access(appBuilderPath, constants.X_OK);
    } catch {
      await fs.chmod(appBuilderPath, 0o755);
    }
  }
  const env = { ...process.env };
  delete env.SYNAX_UPDATE_SIGNING_KEY;
  await run(
    appBuilderPath,
    [
      "blockmap",
      "--input",
      source,
      "--output",
      output,
      "--compression",
      "gzip",
    ],
    { timeout: 5 * 60_000, maxBuffer: 1024 * 1024, env },
  );
  const size = (await fs.stat(output)).size;
  if (size <= 0 || size > MAX_BLOCK_MAP_SIZE)
    throw new Error("Desktop blockmap exceeds size limit");
  return { name: path.basename(output), size, sha256: await hashFile(output) };
}
