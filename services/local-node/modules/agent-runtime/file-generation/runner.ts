import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as z from "zod/v4";
import { runtimeAsset } from "../../../infrastructure/runtime/runtime-paths.js";
import { resolvePythonRuntime } from "../../../infrastructure/runtime/python-runtime.js";
import { sandboxConfigForSession } from "../sandbox/index.js";
import { workspaceRoot } from "../tools/workspace.js";
import { runCommand } from "../tools/exec-async.js";
import { decodeText, generationTimeout, MAX_DIAGNOSTIC_BYTES, MAX_FILES, MAX_FILE_BYTES, MAX_MANIFEST_BYTES, MAX_SCRIPT_CHARS, MAX_TOTAL_BYTES } from "./limits.js";

export interface StagedOperation { type: "write" | "delete"; path: string; content?: string; movePath?: string }
export interface GenerationRead { path: string; sha256: string; bytes: number }
export interface GenerationPlan {
  operations: StagedOperation[];
  reads: GenerationRead[];
  requiresDelete: string[];
  diagnostics: { stdout: string; stderr: string };
}
export class GenerationError extends Error {
  constructor(message: string, readonly diagnostics = { stdout: "", stderr: "" }) { super(message); }
}
const filePath = z.string().min(1).max(4096).refine(value => !value.includes("\0"));
const entrySchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("write"), path: filePath, contentFile: z.string().regex(/^\d+\.txt$/) }).strict(),
  z.object({ type: z.literal("delete"), path: filePath, movePath: filePath.optional() }).strict(),
  z.object({ type: z.literal("read"), path: filePath, sha256: z.string().regex(/^[a-f0-9]{64}$/), bytes: z.number().int().min(0).max(MAX_FILE_BYTES) }).strict(),
  z.object({ type: z.literal("requiresDelete"), path: filePath }).strict(),
  z.object({ type: z.literal("complete"), version: z.literal(1) }).strict(),
]);

function readBounded(file: string, limit: number): Buffer {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.size > limit) throw new Error(`Invalid or oversized staging file: ${path.basename(file)}`);
  return fs.readFileSync(file);
}

export function readGenerationManifest(directory: string): Omit<GenerationPlan, "diagnostics"> {
  const lines = decodeText(readBounded(path.join(directory, "manifest.jsonl"), MAX_MANIFEST_BYTES)).trim().split("\n");
  if (lines.length > MAX_FILES * 3 + 1) throw new Error("Too many manifest entries; split the request.");
  const entries = lines.map(line => entrySchema.parse(JSON.parse(line)));
  if (entries.at(-1)?.type !== "complete" || entries.slice(0, -1).some(entry => entry.type === "complete"))
    throw new Error("The generation script did not complete normally.");
  const operations: StagedOperation[] = [];
  const reads: GenerationRead[] = [];
  const requiresDelete: string[] = [];
  let bytes = 0;
  let readBytes = 0;
  for (const entry of entries) {
    if (entry.type === "write") {
      const data = readBounded(path.join(directory, "staging", entry.contentFile), MAX_FILE_BYTES);
      bytes += data.length;
      if (bytes > MAX_TOTAL_BYTES) throw new Error("Generated content exceeds 64 MB; split the request.");
      operations.push({ type: "write", path: entry.path, content: decodeText(data) });
    } else if (entry.type === "delete") operations.push(entry);
    else if (entry.type === "read") { reads.push(entry); readBytes += entry.bytes; }
    else if (entry.type === "requiresDelete") requiresDelete.push(entry.path);
  }
  if ([operations, reads, requiresDelete].some(items => items.length > MAX_FILES) || readBytes > MAX_TOTAL_BYTES)
    throw new Error("Generation limit exceeded; split the request.");
  return { operations, reads, requiresDelete };
}

export async function runGenerationScript(sessionId: string, script: string, timeoutMs?: number, signal?: AbortSignal): Promise<GenerationPlan> {
  if (!script.trim() || script.length > MAX_SCRIPT_CHARS) throw new Error("script must contain 1–65,536 characters.");
  const python = resolvePythonRuntime();
  if (!python) throw new Error("file.generate requires the bundled Python runtime (or python3 in development).");
  signal?.throwIfAborted();
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "synax-generate-"));
  fs.chmodSync(directory, 0o700);
  let diagnostics = { stdout: "", stderr: "" };
  try {
    fs.mkdirSync(path.join(directory, "staging"));
    fs.copyFileSync(runtimeAsset(import.meta.url, "bootstrap.py", "file-generation/bootstrap.py"), path.join(directory, "bootstrap.py"));
    fs.writeFileSync(path.join(directory, "user_script.py"), script, "utf8");
    const config = sandboxConfigForSession(sessionId);
    fs.writeFileSync(path.join(directory, "config.json"), JSON.stringify({
      readRoots: (config.workspaceRoots ?? []).map(root => fs.realpathSync(root)),
      blockedExtensions: [...config.blockedExtensions], maxDepth: Number.isFinite(config.maxDepth) ? config.maxDepth : 4096,
    }));
    const env: NodeJS.ProcessEnv = { HOME: directory, USERPROFILE: directory, TMPDIR: directory, TMP: directory, TEMP: directory };
    // Windows needs its OS directory to load system DLLs. No PATH, proxies or credentials.
    for (const key of ["SystemRoot", "WINDIR", "SYSTEMROOT"]) if (process.env[key]) env[key] = process.env[key];
    const result = await runCommand(python, ["-I", "-B", "-X", "utf8", path.join(directory, "bootstrap.py")], {
      cwd: workspaceRoot(sessionId), env, inheritEnv: false, signal,
      timeoutMs: generationTimeout(timeoutMs), maxBufferBytes: MAX_DIAGNOSTIC_BYTES,
    });
    const bounded = (text: string) => Buffer.from(text).subarray(0, MAX_DIAGNOSTIC_BYTES).toString("utf8").replace(/\uFFFD$/, "");
    diagnostics = { stdout: bounded(result.stdout), stderr: bounded(result.stderr) };
    if (result.error || result.timedOut || result.status !== 0)
      throw new Error(result.error?.message ?? (result.timedOut ? "Generation script timed out." : `Generation script exited with status ${result.status}.`));
    if (fs.existsSync(path.join(directory, "denied"))) throw new Error("The script attempted a forbidden operation.");
    signal?.throwIfAborted();
    return { ...readGenerationManifest(directory), diagnostics };
  } catch (error) {
    throw new GenerationError(error instanceof Error ? error.message : String(error), diagnostics);
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
}
