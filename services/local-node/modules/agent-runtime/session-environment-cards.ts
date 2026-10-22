import fs from "node:fs";
import path from "node:path";
import {
  canonicalWorkspaceDirectory,
  isWithinWorkspace,
  workspaceRootHostPath,
  type ProjectWorkspaceRoot,
} from "../project-workspace.js";
import { agentRuntimeStore } from "./session-store.js";
import {
  resolveSessionWorkspaceRoots,
  resolveWorkspaceRootsFromSession,
} from "./tools/workspace.js";
import { patchFilePaths } from "./tools/patch-format.js";
import { AgentNotFoundError, AgentValidationError } from "./runtime-errors.js";
import type {
  AgentRuntimeMessage,
  AgentSession,
  AgentSessionStatus,
  ToolCallRecord,
} from "./contracts.js";
import { getAsset } from "./media-assets.js";
import { resolveSafeFile } from "./workspace-paths.js";

/**
 * Session-scoped environment cards.
 *
 * Each card answers one question about this conversation and is cached,
 * invalidated and timed out on its own. Nothing here probes Git: the workspace
 * snapshot (`workspace-git-changes.ts`) owns that, and the client joins the two
 * layers.
 */

export interface SessionEnvironmentSubagent {
  id: string;
  parentSessionId: string | null;
  subagentName?: string;
  roleName?: string;
  roleDescription?: string;
  profileId: string;
  status: AgentSessionStatus;
  title: string | null;
  prompt: string;
  updatedAt: string;
  completedAt: string | null;
  resultSummary: string | null;
}

export type SessionEnvironmentInputSourceKind =
  | "file"
  | "search"
  | "command"
  | "url"
  | "attachment"
  | "tool";

export interface SessionEnvironmentInputSource {
  toolCallId?: string;
  kind: SessionEnvironmentInputSourceKind;
  label: string;
  path?: string;
  assetId?: string;
}

export interface SessionRootSummary {
  rootId: string;
  name: string;
  role: "primary" | "reference";
  status: "ready" | "missing";
  workspacePath: string;
}

/** `roots` card: the session's workspace binding, without any transcript read. */
export interface SessionEnvironmentRoots {
  sessionId: string;
  projectId: string;
  workspacePath: string;
  repositories: SessionRootSummary[];
  refreshedAt: string;
}

export interface SessionEnvironmentSubagents {
  sessionId: string;
  subagents: SessionEnvironmentSubagent[];
  refreshedAt: string;
}

/** `inputs` card: what this conversation read, keyed by workspace root id. */
export interface SessionEnvironmentInputs {
  sessionId: string;
  projectId: string;
  primaryRootId: string;
  byRoot: Record<string, SessionEnvironmentInputSource[]>;
  refreshedAt: string;
}

/** `outputs` card: files this conversation wrote, plus its write attribution. */
export interface SessionEnvironmentOutputs {
  sessionId: string;
  projectId: string;
  primaryRootId: string;
  byRoot: Record<string, string[]>;
  editedPathsByRoot: Record<string, string[]>;
  refreshedAt: string;
}

/** Runtime records a card needs; omitted fields are read from the store. */
export interface SessionCardRecords {
  session?: AgentSession;
  toolCalls?: ToolCallRecord[];
  messages?: AgentRuntimeMessage[];
  children?: AgentSession[];
  assetNames?: ReadonlyMap<string, string>;
}

const ROOTS_TTL_MS = 120_000;
const SUBAGENTS_TTL_MS = 15_000;
const TOOL_TTL_MS = 30_000;
const CARD_CACHE_LIMIT = 64;

interface CardEntry<T> {
  value: T;
  expiresAt: number;
}

const rootsCache = new Map<string, CardEntry<SessionEnvironmentRoots>>();
const subagentsCache = new Map<string, CardEntry<SessionEnvironmentSubagents>>();
const inputsCache = new Map<string, CardEntry<SessionEnvironmentInputs>>();
const outputsCache = new Map<string, CardEntry<SessionEnvironmentOutputs>>();
const rootsInFlight = new Map<string, Promise<SessionEnvironmentRoots>>();
const subagentsInFlight = new Map<string, Promise<SessionEnvironmentSubagents>>();
const inputsInFlight = new Map<string, Promise<SessionEnvironmentInputs>>();
const outputsInFlight = new Map<string, Promise<SessionEnvironmentOutputs>>();

function setCard<T>(
  cache: Map<string, CardEntry<T>>,
  sessionId: string,
  value: T,
  ttlMs: number,
): T {
  cache.delete(sessionId);
  cache.set(sessionId, { value, expiresAt: Date.now() + ttlMs });
  while (cache.size > CARD_CACHE_LIMIT) cache.delete(cache.keys().next().value!);
  return value;
}

/** Shared cache + single-flight; `compute` only runs on a miss. */
async function readCard<T>(
  sessionId: string,
  cache: Map<string, CardEntry<T>>,
  inFlight: Map<string, Promise<T>>,
  ttlMs: number,
  compute: () => Promise<T>,
): Promise<T> {
  const cached = cache.get(sessionId);
  if (cached && Date.now() < cached.expiresAt) return cached.value;
  const pending = inFlight.get(sessionId);
  if (pending) return pending;
  const task = compute()
    .then((value) => setCard(cache, sessionId, value, ttlMs))
    .finally(() => {
      if (inFlight.get(sessionId) === task) inFlight.delete(sessionId);
    });
  inFlight.set(sessionId, task);
  return task;
}

function getSession(sessionId: string): AgentSession {
  try {
    return agentRuntimeStore.getSession(sessionId);
  } catch {
    throw new AgentNotFoundError(sessionId);
  }
}

function sessionRoots(
  sessionId: string,
  records: SessionCardRecords,
  session: AgentSession,
): ProjectWorkspaceRoot[] {
  return records.session
    ? resolveWorkspaceRootsFromSession(session)
    : resolveSessionWorkspaceRoots(sessionId, session.projectId);
}

function canonicalPath(root: ProjectWorkspaceRoot): string | null {
  try {
    return canonicalWorkspaceDirectory(workspaceRootHostPath(root));
  } catch {
    return null;
  }
}

export async function getSessionEnvironmentRoots(
  sessionId: string,
  load?: () => Promise<SessionCardRecords>,
): Promise<SessionEnvironmentRoots> {
  return readCard(sessionId, rootsCache, rootsInFlight, ROOTS_TTL_MS, async () => {
    const records = (await load?.()) ?? {};
    const session = records.session ?? getSession(sessionId);
    const resolved = sessionRoots(sessionId, records, session);
    const repositories: SessionRootSummary[] = [];
    for (const root of resolved) {
      const workspacePath = canonicalPath(root);
      if (!workspacePath) continue;
      repositories.push({
        rootId: root.id,
        name: root.name,
        role: root.role,
        status: "ready",
        workspacePath,
      });
    }
    const missing = resolved.find((root) => !canonicalPath(root));
    if (missing)
      repositories.push({
        rootId: missing.id,
        name: missing.name,
        role: missing.role,
        status: "missing",
        workspacePath: missing.path,
      });
    const primary =
      repositories.find((root) => root.role === "primary") ?? repositories[0];
    if (!primary)
      throw new AgentValidationError("The session has no workspace projects.");
    return {
      sessionId,
      projectId: session.projectId,
      workspacePath: primary.workspacePath,
      repositories,
      refreshedAt: new Date().toISOString(),
    };
  });
}

function readSubagents(
  sessionId: string,
  session: AgentSession,
  children?: AgentSession[],
): SessionEnvironmentSubagent[] {
  const ids = session.childSessionIds ?? [];
  const byId = new Map((children ?? []).map((child) => [child.id, child]));
  const subagents: SessionEnvironmentSubagent[] = [];
  for (const childId of ids) {
    try {
      const child = byId.get(childId) ?? agentRuntimeStore.getSession(childId);
      if (!child) continue;
      if (child.sessionMetadata?.archivedAt || child.sessionMetadata?.deletedAt)
        continue;
      subagents.push({
        id: child.id,
        parentSessionId: child.parentSessionId,
        subagentName:
          typeof child.sessionMetadata?.subagentName === "string"
            ? child.sessionMetadata.subagentName
            : undefined,
        roleName:
          typeof child.sessionMetadata?.roleName === "string"
            ? child.sessionMetadata.roleName
            : undefined,
        roleDescription:
          typeof child.sessionMetadata?.roleDescription === "string"
            ? child.sessionMetadata.roleDescription
            : undefined,
        profileId: child.profileId,
        status: child.status,
        title: child.title,
        prompt: child.prompt,
        updatedAt: child.updatedAt,
        completedAt: child.completedAt,
        resultSummary: child.resultSummary,
      });
    } catch {
      // The child may have been deleted between the projection read and this one.
    }
  }
  return subagents;
}

export async function getSessionEnvironmentSubagents(
  sessionId: string,
  load?: () => Promise<SessionCardRecords>,
): Promise<SessionEnvironmentSubagents> {
  return readCard(
    sessionId,
    subagentsCache,
    subagentsInFlight,
    SUBAGENTS_TTL_MS,
    async () => {
      const records = (await load?.()) ?? {};
      const session = records.session ?? getSession(sessionId);
      return {
        sessionId,
        subagents: readSubagents(sessionId, session, records.children),
        refreshedAt: new Date().toISOString(),
      };
    },
  );
}

function memberRelativePath(
  candidate: string,
  workspacePath: string,
  primaryPath: string,
): string {
  const resolved = path.resolve(primaryPath, candidate);
  const absolute = fs.existsSync(resolved)
    ? fs.realpathSync(resolved)
    : resolved;
  if (!isWithinWorkspace(workspacePath, absolute))
    throw new Error("Another project");
  return path
    .relative(workspacePath, absolute)
    .replace(/\\/g, "/")
    .trim();
}

function readInputSources(
  workspacePath: string,
  primaryPath: string,
  toolCalls: ToolCallRecord[],
  messages: AgentRuntimeMessage[],
  assetNames?: ReadonlyMap<string, string>,
): SessionEnvironmentInputSource[] {
  const sources = new Map<string, SessionEnvironmentInputSource>();
  for (const call of toolCalls) {
    if (call.status !== "completed" || call.mutability !== "read") continue;
    const envelope =
      call.inputRef && typeof call.inputRef === "object"
        ? (call.inputRef as Record<string, unknown>)
        : {};
    const input =
      envelope.nativeTool && typeof envelope.nativeTool === "object"
        ? (envelope.nativeTool as Record<string, unknown>)
        : envelope;
    const candidate = input.path ?? input.file_path ?? input.notebook_path;
    if (typeof candidate === "string" && candidate.trim()) {
      try {
        const relativePath = memberRelativePath(
          candidate,
          workspacePath,
          primaryPath,
        );
        if (!fs.statSync(path.join(workspacePath, relativePath)).isFile())
          throw new Error("Not a file");
        sources.set(`file:${relativePath}`, {
          toolCallId: call.id,
          kind: "file",
          label: relativePath,
          path: relativePath,
        });
        continue;
      } catch {
        // Ignore paths outside this workspace member; command-style reads are
        // intentionally not listed as input sources below.
      }
    }
    // Only concrete workspace files and external web reads belong in the
    // input source list; search, shell command and generic tool reads would
    // only surface raw JSON summaries here.
    if (!/url|web|http/i.test(call.toolId)) continue;
    const label =
      (typeof input.url === "string" && input.url.trim()) ||
      (typeof input.query === "string" && input.query.trim()) ||
      call.inputSummary?.trim() ||
      call.toolId;
    sources.set(`url:${call.toolId}:${label}`, {
      kind: "url",
      label,
      toolCallId: call.id,
    });
  }
  // Files the user attached to their messages count as input sources too.
  for (const message of messages) {
    if (message.role !== "user" || !Array.isArray(message.contentParts))
      continue;
    for (const part of message.contentParts) {
      if (part.type === "text") continue;
      const assetId = (part as { assetId?: unknown }).assetId;
      if (typeof assetId !== "string" || !assetId) continue;
      let label = assetId;
      try {
        const filename = assetNames
          ? assetNames.get(assetId)
          : getAsset(assetId).filename;
        if (filename) label = filename;
      } catch {
        // Asset metadata is gone; fall back to the raw asset id.
      }
      sources.set(`attachment:${assetId}`, {
        kind: "attachment",
        label,
        assetId,
      });
    }
  }
  return [...sources.values()];
}

/** Tools whose execution means "this session wrote to that path". */
const AGENT_WRITE_TOOL_IDS = new Set([
  "edit", // Historical calls remain attributable after the tool is unmounted.
  "file.write",
  "file.delete",
  "file.patch",
]);

function readAgentEditedPaths(
  workspacePath: string,
  primaryPath: string,
  toolCalls: ToolCallRecord[],
): Set<string> {
  const paths = new Set<string>();
  const add = (candidate: unknown) => {
    if (typeof candidate !== "string" || !candidate.trim()) return;
    try {
      paths.add(memberRelativePath(candidate, workspacePath, primaryPath));
    } catch {
      /* Ignore paths outside this workspace member. */
    }
  };
  for (const call of toolCalls) {
    if (call.status !== "completed") continue;
    const raw = call.inputRef;
    if (!raw || typeof raw !== "object") continue;
    const envelope = raw as Record<string, unknown>;
    const input =
      envelope.nativeTool && typeof envelope.nativeTool === "object"
        ? (envelope.nativeTool as Record<string, unknown>)
        : envelope;
    if (call.toolId === "codex.fileChange") {
      // Codex sends the definitive changed paths with the completed result.
      const changes = Array.isArray(call.outputRef)
        ? call.outputRef
        : input.changes;
      if (Array.isArray(changes))
        for (const change of changes) {
          if (change && typeof change === "object")
            add((change as { path?: unknown }).path);
        }
    } else if (call.toolId === "file.patch") {
      for (const candidate of patchFilePaths(input.patch)) add(candidate);
    } else if (AGENT_WRITE_TOOL_IDS.has(call.toolId)) {
      add(input.path);
    }
  }
  return paths;
}

export async function getSessionEnvironmentInputs(
  sessionId: string,
  load?: () => Promise<SessionCardRecords>,
): Promise<SessionEnvironmentInputs> {
  return readCard(sessionId, inputsCache, inputsInFlight, TOOL_TTL_MS, async () => {
    const records = (await load?.()) ?? {};
    const session = records.session ?? getSession(sessionId);
    const resolved = sessionRoots(sessionId, records, session);
    const primary = resolved.find((root) => root.role === "primary") ?? resolved[0];
    if (!primary)
      throw new AgentValidationError("The session has no workspace projects.");
    const toolCalls = records.toolCalls ?? agentRuntimeStore.listToolCalls(sessionId);
    const messages = records.messages ?? agentRuntimeStore.listMessages(sessionId);
    const primaryPath = workspaceRootHostPath(primary);
    const byRoot: Record<string, SessionEnvironmentInputSource[]> = {};
    for (const root of resolved) {
      const workspacePath = canonicalPath(root);
      if (!workspacePath) continue;
      byRoot[root.id] = readInputSources(
        workspacePath,
        primaryPath,
        toolCalls,
        messages,
        records.assetNames,
      );
    }
    return {
      sessionId,
      projectId: session.projectId,
      primaryRootId: primary.id,
      byRoot,
      refreshedAt: new Date().toISOString(),
    };
  });
}

export async function getSessionEnvironmentOutputs(
  sessionId: string,
  load?: () => Promise<SessionCardRecords>,
): Promise<SessionEnvironmentOutputs> {
  return readCard(sessionId, outputsCache, outputsInFlight, TOOL_TTL_MS, async () => {
    const records = (await load?.()) ?? {};
    const session = records.session ?? getSession(sessionId);
    const resolved = sessionRoots(sessionId, records, session);
    const primary = resolved.find((root) => root.role === "primary") ?? resolved[0];
    if (!primary)
      throw new AgentValidationError("The session has no workspace projects.");
    const toolCalls = records.toolCalls ?? agentRuntimeStore.listToolCalls(sessionId);
    const primaryPath = workspaceRootHostPath(primary);
    const byRoot: Record<string, string[]> = {};
    const editedPathsByRoot: Record<string, string[]> = {};
    for (const root of resolved) {
      const workspacePath = canonicalPath(root);
      if (!workspacePath) continue;
      const edited = [
        ...readAgentEditedPaths(workspacePath, primaryPath, toolCalls),
      ];
      editedPathsByRoot[root.id] = edited;
      byRoot[root.id] = edited.filter((relativePath) => {
        try {
          return fs.statSync(resolveSafeFile(workspacePath, relativePath)).isFile();
        } catch {
          return false;
        }
      });
    }
    return {
      sessionId,
      projectId: session.projectId,
      primaryRootId: primary.id,
      byRoot,
      editedPathsByRoot,
      refreshedAt: new Date().toISOString(),
    };
  });
}

/** Drop every card for one session; called by the shared invalidator. */
export function invalidateSessionEnvironmentCards(sessionId: string): void {
  rootsCache.delete(sessionId);
  subagentsCache.delete(sessionId);
  inputsCache.delete(sessionId);
  outputsCache.delete(sessionId);
  rootsInFlight.delete(sessionId);
  subagentsInFlight.delete(sessionId);
  inputsInFlight.delete(sessionId);
  outputsInFlight.delete(sessionId);
}

export function invalidateAllSessionEnvironmentCards(): void {
  rootsCache.clear();
  subagentsCache.clear();
  inputsCache.clear();
  outputsCache.clear();
  rootsInFlight.clear();
  subagentsInFlight.clear();
  inputsInFlight.clear();
  outputsInFlight.clear();
}
