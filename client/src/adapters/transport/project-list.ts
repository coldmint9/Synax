import type { ProjectSummary } from "../../shared/state/shellStore";
import { createAppError } from "../../shared/lib/errors";
import { apiFetch } from "./origin";

const API_BASE = "/api/projects";

export interface ProjectListParams {
  search?: string;
  status?: string;
  environment?: string;
  importState?: string;
  sort?:
    | "name"
    | "healthScore"
    | "updatedAt"
    | "status"
    | "environment"
    | "createdAt";
  order?: "asc" | "desc";
}

/** List projects without importing the full project mutation API. */
export async function listProjects(
  params?: ProjectListParams,
  options?: { throwOnError?: boolean },
): Promise<{ items: ProjectSummary[]; total: number }> {
  try {
    const qs = new URLSearchParams();
    if (params?.search) qs.set("search", params.search);
    if (params?.status) qs.set("status", params.status);
    if (params?.environment) qs.set("environment", params.environment);
    if (params?.importState) qs.set("importState", params.importState);
    if (params?.sort) qs.set("sort", params.sort);
    if (params?.order) qs.set("order", params.order);
    const url = qs.toString() ? `${API_BASE}?${qs.toString()}` : API_BASE;
    const resp = await apiFetch(url);
    if (!resp.ok) throw createAppError(`HTTP ${resp.status}`, resp.status);
    const data = await resp.json();
    const items = (data.items ?? []).map((p: Record<string, unknown>) =>
      mapToProjectSummary(p),
    );
    return { items, total: (data.total as number) ?? items.length };
  } catch (error) {
    if (options?.throwOnError) throw error;
    return { items: [], total: 0 };
  }
}

function mapProjectSource(raw: unknown): ProjectSummary["source"] | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const s = raw as Record<string, unknown>;
  const kindRaw = s.kind as string | undefined;
  const repo = s.repoUrl as string | undefined;
  const branch = s.branch as string | undefined;
  const localPath = s.localPath as string | undefined;
  const distribution = s.distribution as string | undefined;
  const wslPath = s.path as string | undefined;

  if (kindRaw === "scratch") return { kind: "scratch", localPath };
  if (kindRaw === "git") return { kind: "github", repo, branch, localPath };
  if (kindRaw === "localPath")
    return { kind: "localPath", localPath, repo, branch };
  if (kindRaw === "wsl" && distribution && wslPath)
    return { kind: "wsl", distribution, wslPath, localPath: wslPath };
  if (kindRaw === "gitlab") return { kind: "gitlab", repo, branch, localPath };
  return undefined;
}

export function mapToProjectSummary(
  p: Record<string, unknown>,
): ProjectSummary {
  return {
    id: p.id as string,
    name: p.name as string,
    status: (p.status as string as ProjectSummary["status"]) ?? "healthy",
    environment:
      (p.environment as string as ProjectSummary["environment"]) ??
      "development",
    healthScore: (p.healthScore as number) ?? 0,
    activeAgents: (p.activeAgents as number) ?? 0,
    activeHumans: (p.activeHumans as number) ?? 1,
    openRisks: (p.openRisks as number) ?? 0,
    updatedAt: (p.updatedAt as string) ?? "just now",
    source: mapProjectSource(p.source),
    importState: p.importState as string as ProjectSummary["importState"],
    importError: p.importError as string,
    createdBy: (p.createdBy as string) ?? "current-user",
    createdAt: (p.createdAt as string) ?? new Date().toISOString(),
  };
}
