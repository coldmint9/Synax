import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, it, expect, vi } from "vitest";
import type { AgentRuntimeMessage } from "../contracts.js";
const mock = vi.hoisted(() => ({
  root: "",
  update: vi.fn((id, metadata) => ({ metadata })),
  get: vi.fn(() => ({ projectId: "p" })),
  persisted: null as AgentRuntimeMessage | null,
}));
vi.mock("../session-store.js", () => ({
  agentRuntimeStore: {
    getSession: mock.get,
    attachPrototypeMetadata: mock.update,
    getMessage: () => mock.persisted,
  },
}));
vi.mock("../tools/workspace.js", () => ({
  resolveSessionWorkDir: () => mock.root,
}));
import { compileCompletedPrototypes } from "../prototype-integration.js";
function message(source = "demo.html", kind = "html"): AgentRuntimeMessage {
  const m: AgentRuntimeMessage = {
    id: "m",
    sessionId: "s",
    runId: "r",
    stepId: "step",
    role: "assistant",
    content:
      "Here is your demo\n```synax-prototype\n" +
      JSON.stringify({ sourcePath: source, title: "Demo", sourceKind: kind }) +
      "\n```",
    metadata: { source: "codex" },
    createdAt: "",
  };
  mock.persisted = m;
  return m;
}
afterEach(() => {
  if (mock.root) fs.rmSync(mock.root, { recursive: true, force: true });
  mock.root = "";
  vi.clearAllMocks();
});
it("compiles HTML into the same message once, not affected by later file deletion", async () => {
  mock.root = fs.mkdtempSync(path.join(os.tmpdir(), "prototype-test-"));
  fs.writeFileSync(path.join(mock.root, "demo.html"), "<button>Demo</button>");
  const m = message();
  await compileCompletedPrototypes(m);
  const saved = structuredClone(m.metadata);
  expect(saved.prototypes).toHaveLength(1);
  expect((saved.prototypes as any)[0].html).toContain("Demo");
  expect(saved.prototypeDisplayText).toBe("Here is your demo");
  fs.unlinkSync(path.join(mock.root, "demo.html"));
  await compileCompletedPrototypes(m);
  expect(mock.update).toHaveBeenCalledTimes(1);
  expect(m.metadata).toEqual(saved);
});
it("compiles TSX with fixed React dependencies", async () => {
  mock.root = fs.mkdtempSync(path.join(os.tmpdir(), "prototype-test-"));
  fs.writeFileSync(
    path.join(mock.root, "demo.tsx"),
    "export default function Demo(){return <button>React Demo</button>}",
  );
  const m = message("demo.tsx", "react");
  await compileCompletedPrototypes(m);
  expect((m.metadata.prototypes as any)[0].html).toContain("React Demo");
});
it("does not compile partial/user messages", async () => {
  await compileCompletedPrototypes({ ...message(), role: "user" });
  await compileCompletedPrototypes({
    ...message(),
    metadata: { partial: true },
  });
  expect(mock.update).not.toHaveBeenCalled();
});
it("records safe errors for missing/unsafe inputs without failing text replies", async () => {
  mock.root = fs.mkdtempSync(path.join(os.tmpdir(), "prototype-test-"));
  const m = message();
  await compileCompletedPrototypes(m);
  expect(m.metadata.prototypes).toEqual([]);
  expect(m.metadata.prototypeDiagnostics).toHaveLength(1);
  expect(JSON.stringify(m.metadata.prototypeDiagnostics)).not.toContain(
    mock.root,
  );
});
