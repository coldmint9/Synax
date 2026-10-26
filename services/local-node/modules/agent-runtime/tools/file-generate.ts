import * as z from "zod/v4";
import type { RegisteredTool } from "../contracts.js";
import { commitGeneration } from "../file-generation/commit.js";
import { GenerationError, runGenerationScript } from "../file-generation/runner.js";
import { MAX_SCRIPT_CHARS } from "../file-generation/limits.js";

export const fileGenerateTool: RegisteredTool = {
  id: "file.generate", label: "Generate Files", category: "write", internalGate: "write", mutability: "write",
  resumeBehavior: "wait_permission", executionTimeoutMs: 120_000,
  description: "Generate templates, multi-file scaffolds, batch rewrites or long/escape-sensitive text using Python 3. Prefer file.patch for small edits and file.write for short complete files. All operations are staged, validated and committed together; failures roll back writes.",
  progressiveDetails: "Accepts {script, timeoutMs?}. Script runs as __main__. import synax; synax.write(path, text), synax.delete(path), synax.move(source, destination), synax.read(path), synax.exists(path), synax.list_dir(path). Only synax helpers stage writes; ordinary open()/pathlib can only read workspace files. Use workspace-relative paths or sandbox-permitted absolute paths; specialist writes must stay inside writeScope. Delete/move require file.delete capability. Repeated writes keep the last value; synax.read/exists/list_dir see staged changes, while ordinary open() reads the disk. Limits: 120 files, 64 MB total, 8 MB per file, stdout/stderr each 8 KB; UTF-8 only, no NUL. timeoutMs defaults to 30000, clamped to 1000–120000. No network or subprocesses. Print key decisions for diagnostics. Approval shows source, not a final file list. Audit hooks are guardrails, not a hardened sandbox. Partial rollback failures are reported with residualPaths; rolledBack is true only after complete restoration.",
  inputSchema: z.object({
    script: z.string().min(1).max(MAX_SCRIPT_CHARS).refine(value => Boolean(value.trim()), "script must not be blank").describe("Python 3 source; use import synax and synax.write/delete/move for all mutations."),
    timeoutMs: z.number().finite().optional().describe("Script timeout in milliseconds, clamped to 1000–120000; default 30000."),
  }),
  async execute(input) {
    let diagnostics = { stdout: "", stderr: "" };
    try {
      const { script, timeoutMs } = fileGenerateTool.inputSchema!.parse(input.args) as { script: string; timeoutMs?: number };
      const plan = await runGenerationScript(input.sessionId, script, timeoutMs, input.abortSignal);
      diagnostics = plan.diagnostics;
      const result = await commitGeneration(input.sessionId, plan, input.abortSignal);
      const summary = result.error ? `File generation failed: ${result.error}${result.rolledBack ? " All writes restored." : ` Residual paths: ${result.residualPaths?.join(", ")}.`}` : `Generated ${result.totals.files} files (${result.totals.bytes} bytes).`;
      return { ...(result.error ? { outcome: "failed" as const } : {}), result: { ...result, diagnostics }, displaySummary: summary,
        artifacts: [{ kind: "decision", title: "File generation", summary, risk: result.residualPaths?.length || plan.requiresDelete.length || plan.operations.some(item => item.type === "delete") ? "high" : "medium", metadata: { files: result.files, ...result.error ? { error: result.error } : {}, ...result.residualPaths ? { residualPaths: result.residualPaths } : {} } }],
      };
    } catch (error) {
      if (error instanceof GenerationError) diagnostics = error.diagnostics;
      const message = error instanceof Error ? error.message : String(error);
      return { outcome: "failed", result: { error: message, files: [], totals: { files: 0, bytes: 0, additions: 0, deletions: 0 }, diagnostics }, displaySummary: `File generation failed: ${message}`, artifacts: [] };
    }
  },
};
