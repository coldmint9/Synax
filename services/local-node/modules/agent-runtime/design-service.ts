import fs from "node:fs";
import path from "node:path";
import { AgentRuntimeError, AgentValidationError } from "./runtime-errors.js";
import { agentRuntimeStore } from "./session-store.js";
import { workspaceRoot } from "./tools/workspace.js";
import { nowIso } from "./runtime-ids.js";

export const DESIGN_STATUSES = [
  "draft",
  "review",
  "approved",
  "implementing",
  "completed",
] as const;
export type DesignStatus = (typeof DESIGN_STATUSES)[number];

export interface SessionDesignMetadata {
  relativePath: string;
  revision: number;
  status: DesignStatus;
  updatedAt: string;
}

export interface DesignSnapshot extends SessionDesignMetadata {
  content: string;
}

const DESIGN_RELATIVE_PATH = (sessionId: string) =>
  `.synax/designs/${sessionId}/design.md`;

function designPath(sessionId: string): {
  relativePath: string;
  absolutePath: string;
} {
  const relativePath = DESIGN_RELATIVE_PATH(sessionId);
  const root = path.resolve(workspaceRoot(sessionId));
  const absolutePath = path.resolve(root, relativePath);
  if (!absolutePath.startsWith(`${root}${path.sep}`))
    throw new AgentValidationError("The design path is outside the session workspace.");
  return { relativePath, absolutePath };
}

function metadata(sessionId: string): SessionDesignMetadata {
  const session = agentRuntimeStore.getSession(sessionId);
  const current = session.sessionMetadata?.design;
  if (!current || typeof current !== "object") {
    return {
      relativePath: DESIGN_RELATIVE_PATH(sessionId),
      revision: 0,
      status: "draft",
      updatedAt: nowIso(),
    };
  }
  const record = current as Partial<SessionDesignMetadata>;
  return {
    relativePath: DESIGN_RELATIVE_PATH(sessionId),
    revision:
      typeof record.revision === "number" && Number.isInteger(record.revision)
        ? Math.max(record.revision, 0)
        : 0,
    status: DESIGN_STATUSES.includes(record.status as DesignStatus)
      ? (record.status as DesignStatus)
      : "draft",
    updatedAt: typeof record.updatedAt === "string" ? record.updatedAt : nowIso(),
  };
}

function saveMetadata(sessionId: string, value: SessionDesignMetadata): void {
  agentRuntimeStore.updateSessionMetadata(sessionId, { design: value });
}

export function readDesign(sessionId: string): DesignSnapshot {
  const { relativePath, absolutePath } = designPath(sessionId);
  const meta = metadata(sessionId);
  if (!fs.existsSync(absolutePath)) return { ...meta, relativePath, content: "" };
  let content: string;
  try {
    content = fs.readFileSync(absolutePath, "utf8");
  } catch (error) {
    throw new AgentRuntimeError(
      `Unable to read design draft: ${(error as Error).message}`,
      "DESIGN_READ_FAILED",
      500,
    );
  }
  return { ...meta, relativePath, content };
}

export function writeDesign(
  sessionId: string,
  content: string,
  expectedRevision?: number,
  requestedStatus?: DesignStatus,
): DesignSnapshot {
  const current = readDesign(sessionId);
  if (
    expectedRevision !== undefined &&
    expectedRevision !== current.revision
  ) {
    throw new AgentRuntimeError(
      `The design revision changed (expected ${expectedRevision}, current ${current.revision}).`,
      "DESIGN_REVISION_CONFLICT",
      409,
    );
  }
  const { relativePath, absolutePath } = designPath(sessionId);
  fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
  const tempPath = `${absolutePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tempPath, content, "utf8");
    fs.renameSync(tempPath, absolutePath);
  } catch (error) {
    try {
      fs.rmSync(tempPath, { force: true });
    } catch {
      // Preserve the original write error.
    }
    throw new AgentRuntimeError(
      `Unable to write design draft: ${(error as Error).message}`,
      "DESIGN_WRITE_FAILED",
      500,
    );
  }
  const next: SessionDesignMetadata = {
    relativePath,
    revision: current.revision + 1,
    status: requestedStatus ?? "draft",
    updatedAt: nowIso(),
  };
  saveMetadata(sessionId, next);
  return { ...next, content };
}

export function transitionDesign(
  sessionId: string,
  status: DesignStatus,
): DesignSnapshot {
  const current = readDesign(sessionId);
  const next: SessionDesignMetadata = {
    ...current,
    status,
    updatedAt: nowIso(),
  };
  saveMetadata(sessionId, next);
  return { ...next, content: current.content };
}
