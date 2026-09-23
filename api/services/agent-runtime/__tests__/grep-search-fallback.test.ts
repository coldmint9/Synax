import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { grepSearchTool } from "../tools/grep-search.js";
import {
  clearSessionWorkspaceRoot,
  setSessionWorkspaceRoot,
} from "../tools/workspace.js";
import * as ripgrep from "../tools/ripgrep.js";

const roots: string[] = [];
const sessionId = "grep-fallback-test";

afterEach(() => {
  vi.restoreAllMocks();
  clearSessionWorkspaceRoot(sessionId);
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

describe("grep.search fallback", () => {
  it("uses grep when bundled ripgrep cannot start", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "synax-grep-fallback-"));
    roots.push(root);
    fs.writeFileSync(path.join(root, "one.ts"), "before\nneedle here\nafter\n");
    fs.writeFileSync(
      path.join(root, "two.txt"),
      "needle in excluded extension\n",
    );
    setSessionWorkspaceRoot(sessionId, root);
    vi.spyOn(ripgrep, "resolveRipgrep").mockResolvedValue(null);

    const result = await grepSearchTool.execute({
      args: {
        query: "needle",
        filePattern: "*.ts",
        contextLines: 1,
      },
      sessionId,
    } as never);

    expect(result.result).toMatchObject({
      query: "needle",
      hits: [
        {
          path: "one.ts",
          line: 2,
          preview: "needle here",
          contextBefore: ["before"],
          contextAfter: ["after"],
        },
      ],
    });
    expect(result.displaySummary).toContain("grep fallback");
  });
});
