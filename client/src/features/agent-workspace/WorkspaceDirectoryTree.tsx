import { ChevronRight, Folder, FolderOpen, LoaderCircle } from "lucide-react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { projectApi, type ProjectWorkspaceRoot, type WorkspaceTreeListing } from "../../adapters/transport/project";
import { useLocale } from "../../shared/hooks/useLocale";
import { Button } from "../../shared/ui/ui/Button";
import { useAgentSessionStore } from "./state/agentSessionStore";
import { openWorkspaceFile } from "./state/sessionWorkspaceStore";
import { FileTypeIcon } from "./FileTypeIcon";
import { useWorkspaceRefresh } from './workspaceRefresh';

const keyOf = (rootId: string, path: string) => JSON.stringify([rootId, path]);
interface Level { page?: WorkspaceTreeListing; loading?: boolean; error?: string }

export function WorkspaceDirectoryTree({ projectId }: { projectId: string }) {
  const sessionId = useAgentSessionStore((s) =>
    s.sessions.find((session) => session.id === s.selectedSessionId && session.projectId === projectId)?.id);
  // Switching sessions can switch the physical worktree. Never retain old root requests.
  const [bindingVersion, setBindingVersion] = useState(0);
  const reset = useCallback(() => setBindingVersion(value => value + 1), []);
  useWorkspaceRefresh(sessionId ?? null, reset);
  return <DirectoryTree key={`${projectId}:${sessionId ?? ""}:${bindingVersion}`} projectId={projectId} sessionId={sessionId} />;
}

function DirectoryTree({ projectId, sessionId }: { projectId: string; sessionId?: string }) {
  const { locale, t } = useLocale();
  const [roots, setRoots] = useState<ProjectWorkspaceRoot[] | null>(null);
  const [rootError, setRootError] = useState<string>();
  const [expanded, setExpanded] = useState(new Set<string>());
  const [levels, setLevels] = useState(new Map<string, Level>());
  const pages = useRef(new Map<string, Level>());
  const requests = useRef(new Map<string, AbortController>());
  const mounted = useRef(true);
  const revisions = useRef(new Map<string, number>());

  const update = useCallback((key: string, value: Level) => {
    if (!mounted.current) return;
    pages.current.set(key, value);
    setLevels(new Map(pages.current));
  }, []);
  const load = useCallback(async (root: ProjectWorkspaceRoot, path: string, more = false, silent = false) => {
    const key = keyOf(root.id, path);
    if (requests.current.has(key) || root.status !== "available") return;
    const previous = pages.current.get(key)?.page;
    if (!more && !silent && previous) return;
    const controller = new AbortController();
    requests.current.set(key, controller);
    if (!silent) update(key, { page: previous, loading: true });
    try {
      const options = { rootId: root.id, path, sessionId, showHidden: true, showIgnored: true,
        limit: 100, signal: controller.signal, cursor: more ? previous?.nextCursor ?? undefined : undefined };
      let next: WorkspaceTreeListing;
      try { next = await projectApi.listWorkspaceTree(projectId, options); }
      catch (error) {
        if ((error as { status?: number }).status !== 409 || controller.signal.aborted) throw error;
        // A rename/delete invalidates continuation cursors. Restart instead of appending duplicates.
        next = await projectApi.listWorkspaceTree(projectId, { ...options, cursor: undefined });
        more = false;
      }
      if (controller.signal.aborted) return;
      if (silent && previous && next.revision === previous.revision &&
          JSON.stringify(next.entries) === JSON.stringify(previous.entries.slice(0, next.entries.length))) return;
      const page = more && previous
        ? { ...next, entries: [...new Map([...previous.entries, ...next.entries].map(e => [e.path, e])).values()] }
        : next;
      update(key, { page });
    } catch (error) {
      if (!controller.signal.aborted) update(key, { page: previous, error: String(error) });
    } finally { requests.current.delete(key); }
  }, [projectId, sessionId, update]);

  useEffect(() => {
    mounted.current = true;
    let cancelled = false;
    void projectApi.getWorkspace(projectId, sessionId).then(({ roots: next }) => {
      if (cancelled) return;
      setRoots(next);
      setExpanded(new Set(next.filter(r => r.status === "available").map(r => keyOf(r.id, ""))));
      // Keep interactive requests bounded even for a 50-member workspace.
      void (async () => {
        for (const root of next) { if (cancelled) return; await load(root, ""); }
      })();
    }).catch(error => { if (!cancelled) setRootError(String(error)); });
    return () => {
      cancelled = true;
      mounted.current = false;
      for (const request of requests.current.values()) request.abort();
      requests.current.clear();
    };
  }, [projectId, sessionId, load]);

  useEffect(() => {
    if (!roots) return;
    let cancelled = false;
    let running = false;
    let ticks = 0;
    const refresh = async () => {
      if (cancelled || running || document.hidden) return;
      running = true;
      try {
        for (const root of roots) {
          if (cancelled || root.status !== "available" || !expanded.has(keyOf(root.id, ""))) continue;
          try {
            const status = await projectApi.workspaceTreeStatus(projectId, root.id, sessionId);
            if (cancelled) return;
            const previous = revisions.current.get(root.id);
            revisions.current.set(root.id, status.revision);
            // Thirty-second reconciliation covers watcher limits/network filesystems.
            if (previous === status.revision && ticks % 15 !== 0) continue;
            for (const key of expanded) {
              const [id, path] = JSON.parse(key) as [string, string];
              const ancestors = path.split("/").slice(0, -1);
              const visible = ancestors.every((_, index) => expanded.has(keyOf(id, ancestors.slice(0, index + 1).join("/"))));
              if (id === root.id && visible && !cancelled) await load(root, path, false, true);
            }
          } catch { /* A temporarily unavailable index retries on the next tick. */ }
        }
      } finally { running = false; ticks++; }
    };
    const timer = setInterval(() => void refresh(), 2000);
    const onVisible = () => { if (!document.hidden) void refresh(); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { cancelled = true; clearInterval(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [roots, expanded, projectId, sessionId, load]);

  const toggle = (root: ProjectWorkspaceRoot, path: string) => {
    const key = keyOf(root.id, path);
    const opening = !expanded.has(key);
    setExpanded(current => {
      const next = new Set(current);
      if (opening) next.add(key); else next.delete(key);
      return next;
    });
    if (opening) void load(root, path, false, true);
  };

  const directory = (root: ProjectWorkspaceRoot, path: string, name: string, depth: number, ignored = false): ReactNode => {
    const key = keyOf(root.id, path);
    const open = expanded.has(key);
    const missing = !path && root.status !== "available";
    return <li key={key} className="workspace-directory-tree-node">
      <button type="button" className={`workspace-directory-tree-row${!path ? " workspace-directory-tree-row--root" : ""}`}
        data-ignored={ignored || undefined} aria-expanded={missing ? undefined : open} disabled={missing}
        style={{ paddingLeft: 8 + depth * 14 }} title={path || root.path} onClick={() => toggle(root, path)}>
        <ChevronRight size={12} aria-hidden="true" className={`workspace-directory-tree-chevron${open ? " workspace-directory-tree-chevron--expanded" : ""}`} />
        {path && (open ? <FolderOpen size={14} aria-hidden="true" /> : <Folder size={14} aria-hidden="true" />)}
        <span className="truncate">{name}</span>
        {missing && <span className="workspace-directory-tree-status">{t("workspaceRepositoryMissing")}</span>}
      </button>
      {open && level(root, path, depth + 1)}
    </li>;
  };
  const level = (root: ProjectWorkspaceRoot, path: string, depth: number): ReactNode => {
    const state = levels.get(keyOf(root.id, path));
    return <ul className="workspace-directory-tree-level">
      {state?.page?.entries.map(entry => entry.kind === "directory"
        ? directory(root, entry.path, entry.name, depth, entry.ignored)
        : <li key={entry.path}><button type="button" className="workspace-directory-tree-row workspace-directory-tree-row--file"
            data-ignored={entry.ignored || undefined} style={{ paddingLeft: 27 + depth * 14 }}
            disabled={!sessionId} title={entry.path}
            onClick={() => sessionId && openWorkspaceFile(sessionId, entry.path, null, root.id, root.name)}>
            <FileTypeIcon path={entry.path} size={14} /><span className="truncate">{entry.name}</span>
          </button></li>)}
      {state?.error && <li className="workspace-directory-tree-error" role="alert">
        <span title={state.error}>{t("workspaceDirectoryTreeFailed")}</span>
        <Button variant="ghost" size="sm" onClick={() => void load(root, path, false, true)}>{locale === "zh" ? "重试" : "Retry"}</Button>
      </li>}
      {state?.loading && <li role="status" className="workspace-directory-tree-status">
        <LoaderCircle size={13} className="animate-spin" aria-hidden="true" />{t("workspaceDirectoryTreeLoading")}
      </li>}
      {!state?.loading && state?.page?.entries.length === 0 && <li className="workspace-directory-tree-status" style={{ paddingLeft: 27 + depth * 14 }}>{t("workspaceDirectoryTreeEmpty")}</li>}
      {state?.page?.nextCursor && <li><Button variant="ghost" size="sm" className="workspace-directory-tree-load-more"
        disabled={state.loading} onClick={() => void load(root, path, true)}>{locale === "zh" ? "加载更多" : "Load more"}</Button></li>}
    </ul>;
  };

  return <nav className="workspace-directory-tree-panel min-h-0 flex-1 overflow-y-auto" aria-label={t("workspaceDirectoryTree")}>
    {rootError ? <div role="alert" className="workspace-directory-tree-error">{rootError}</div>
      : !roots ? <div role="status" className="workspace-directory-tree-status">{t("workspaceDirectoryTreeLoading")}</div>
      : roots.length === 0 ? <div className="workspace-directory-tree-status">{t("workspaceDirectoryTreeEmpty")}</div>
      : <ul className="workspace-directory-tree-level">{roots.map(root => directory(root, "", root.name, 0))}</ul>}
    {!sessionId && <p className="workspace-directory-tree-hint">{t("workspaceDirectoryTreeSelectSession")}</p>}
  </nav>;
}
