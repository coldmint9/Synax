import { createHash } from "node:crypto";
import { resolveSessionWorkDir } from "./tools/workspace.js";
import { agentRuntimeStore as store } from "./session-store.js";
import type { AgentRuntimeMessage } from "./contracts.js";
import { compileArtifact } from "./artifacts/compiler.js";
import { readSnapshot } from "./artifacts/snapshot.js";
import {
  prototypeDeclarations,
  type PrototypeManifest,
} from "./prototype-manifest.js";

export interface InteractivePrototypeMetadata {
  id: string;
  title: string;
  sourceKind: PrototypeManifest["sourceKind"];
  sourceHash: string;
  html: string;
}

export interface PrototypeDiagnostic {
  title: string;
  code: string;
  message: string;
}

function diagnostic(title: string, error: unknown): PrototypeDiagnostic {
  const code =
    error && typeof error === "object" && "code" in error
      ? String(error.code)
      : "BUILD_FAILED";
  return {
    title,
    code,
    message: `原型编译失败 (${code})。请检查源文件后重新生成。`,
  };
}

/** Compile completed assistant declarations once and persist only in message metadata. */
export async function compileCompletedPrototypes(
  message: AgentRuntimeMessage,
  signal?: AbortSignal,
): Promise<void> {
  if (message.role !== "assistant" || message.metadata?.partial) return;
  if (message.metadata?.source === "interactive_prototype") return;
  signal?.throwIfAborted();
  const declarations = prototypeDeclarations(message.content);
  const manifests = declarations.map((d) => d.manifest);
  if (!manifests.length) return;

  const persisted = store.getMessage(message.sessionId, message.id);
  if (
    !persisted ||
    persisted.role !== "assistant" ||
    persisted.content !== message.content ||
    persisted.metadata.partial
  )
    return;
  if (persisted.metadata.source === "interactive_prototype") {
    message.metadata = persisted.metadata;
    return;
  }
  const session = store.getSession(message.sessionId);

  const prototypes: InteractivePrototypeMetadata[] = [];
  const diagnostics: PrototypeDiagnostic[] = [];

  for (const [index, manifest] of manifests.entries()) {
    try {
      const root = resolveSessionWorkDir(message.sessionId, session.projectId);
      const compilation = await compileArtifact(
        readSnapshot(root, manifest.sourcePath),
        manifest.sourceKind,
        { signal },
      );
      const id = `${message.id}:${index}:${createHash("sha256")
        .update(compilation.sourceHash)
        .digest("hex")
        .slice(0, 16)}`;
      prototypes.push({
        id,
        title: manifest.title,
        sourceKind: manifest.sourceKind,
        sourceHash: compilation.sourceHash,
        html: compilation.html,
      });
    } catch (error) {
      signal?.throwIfAborted();
      diagnostics.push(diagnostic(manifest.title, error));
    }
  }

  signal?.throwIfAborted();
  let displayText = message.content;
  for (const d of [...declarations].reverse())
    displayText = displayText.slice(0, d.start) + displayText.slice(d.end);
  const updated = store.attachPrototypeMetadata(message, {
    prototypeDisplayText: displayText.trim(),
    prototypeOrigin: message.metadata.source,
    source: "interactive_prototype",
    prototypes,
    ...(diagnostics.length ? { prototypeDiagnostics: diagnostics } : {}),
  });
  if (updated) message.metadata = updated.metadata;
}
