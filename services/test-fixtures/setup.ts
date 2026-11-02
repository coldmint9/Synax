import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll } from "vitest";
import { prepareTestProcessEnvironment } from "./environment.js";

prepareTestProcessEnvironment();
const root = mkdtempSync(path.join(os.tmpdir(), `Synax-vitest-${process.pid}-`));
process.env.DATA_ROOT = root;

// Registered before suite cleanup; Vitest's stack hook order stops the runtime
// before removing its files. Always delete the owned root, never a stubbed env.
afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
