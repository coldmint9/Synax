import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Bot, Check, Folder, Folders, Trash2 } from 'lucide-react';
import type { GitWorkspaceSummary, GitWorktreeSummary } from '../../adapters/transport/project';
import { agentRuntimeApi } from '../../adapters/transport/agentRuntime';
import { useLocale } from '../../shared/hooks/useLocale';
import type { WorkspaceEnvironmentRepository } from './workspaceEnvironmentView';
import { countWorkspaceGitFiles, WorkspaceGitCountBadges } from './workspaceGitCountBadges';
import { getProjectThemeColor } from './projectThemeColor';
import { useAgentSessionStore } from './state/agentSessionStore';
import { useSessionWorkspaceStore } from './state/sessionWorkspaceStore';
import { invalidateSessionEnvironmentCards } from './useSessionEnvironment';
import { resetSessionWorkspaceGit } from './workspaceGitStore';
import { refreshWorkspace } from './workspaceRefresh';
import { WorktreeDeleteDialog } from '../git/WorktreeDeleteDialog';
import { cachedWorktreeInventory, invalidateWorktreeInventory, loadWorktreeInventory, removeMissingWorktree, WORKTREES_CHANGED } from '../git/worktreeInventory';
import { RepositoryBranchPicker } from './RepositoryBranchPicker';
import './workspaceProjectSwitcher.css';

const pathKey = (value: string) => {
  const windows = /^[a-z]:[\\/]|^\\\\/i.test(value);
  const normalized = windows ? value.replace(/\\/g, '/') : value;
  const wsl = /^\/\/wsl(?:\.localhost|\$)\/[^/]+/i;
  const key = normalized.replace(wsl, '').replace(/\/+$/, '') || '/';
  return windows && !wsl.test(normalized) ? key.toLowerCase() : key;
};
const basename = (value: string) => value.split(/[\\/]/).filter(Boolean).pop() ?? value;

interface ProjectRowProps {
  sessionId: string;
  root: WorkspaceEnvironmentRepository;
  summary?: GitWorkspaceSummary;
  selected: boolean;
  locked: boolean;
  running: boolean;
  userPath?: string;
  executionPath?: string;
  error?: string;
  zh: boolean;
  onSelect: (rootId: string) => void;
  onBind: (root: WorkspaceEnvironmentRepository, path: string) => void;
  onDelete: (root: WorkspaceEnvironmentRepository, tree: GitWorktreeSummary) => void;
  onBranchChanged: (rootId: string) => void;
}
const ProjectRow = memo(function ProjectRow({ sessionId, root, summary, selected, locked, running, userPath, executionPath, error, zh, onSelect, onBind, onDelete, onBranchChanged }: ProjectRowProps) {
  const shadowCount = summary?.worktrees.filter(tree => !tree.primary).length ?? 0;
  const [collapsed, setCollapsed] = useState(false);
  useEffect(() => { if (!selected) setCollapsed(false); }, [selected]);
  const expanded = selected && !collapsed && shadowCount > 0;
  const changeCounts = useMemo(() => root.status === 'ready' ? countWorkspaceGitFiles(root.changedFiles) : undefined, [root.status, root.changedFiles]);
  const branch = root.branch || (root.headCommitSha ? `${zh ? '游离 HEAD' : 'Detached HEAD'} · ${root.headCommitSha.slice(0, 7)}` : '—');
  return <div className="shadow-project-group" data-selected={selected}>
    <div className="shadow-project-header" data-active={selected}>
    <button type="button" className="shadow-project-row" data-active={selected} aria-pressed={selected}
      aria-label={`${root.name} · ${root.branch}`} aria-expanded={shadowCount ? expanded : undefined}
      aria-controls={shadowCount ? `shadow-trees-${root.rootId}` : undefined}
      title={`${root.name}\n${branch}\n${root.workspacePath}`} onClick={() => {
        if (selected && shadowCount > 0) setCollapsed(value => !value);
        else onSelect(root.rootId);
      }}>
      <span className="ws-project-folder-icon" data-project-color={getProjectThemeColor(root.rootId)}>{shadowCount ? <Folders size={17} /> : <Folder size={17} />}</span>
      <span className="shadow-project-text"><strong title={root.name}>{root.name}</strong></span>
      <WorkspaceGitCountBadges counts={changeCounts} />
    </button>
    {selected && root.status === 'ready' && <div className="shadow-project-branch">
      <RepositoryBranchPicker key={`${sessionId}:${root.rootId}:${root.workspacePath}`} sessionId={sessionId} rootId={root.rootId}
        branch={branch} disabled={locked} onSwitched={() => onBranchChanged(root.rootId)} />
    </div>}
    </div>
    {expanded && <div className="shadow-worktrees" id={`shadow-trees-${root.rootId}`}>
      {summary!.worktrees.map(tree => {
        const checked = pathKey(tree.path) === pathKey(userPath ?? root.workspacePath);
        const executing = !tree.prunable && executionPath !== undefined && pathKey(tree.path) === pathKey(executionPath);
        const directory = tree.primary ? zh ? '主目录' : 'Main directory' : basename(tree.path);
        const treeBranch = tree.branch || `${zh ? '游离 HEAD' : 'Detached HEAD'} · ${tree.head.slice(0, 7)}`;
        const label = tree.primary ? directory : treeBranch;
        const detail = tree.primary ? treeBranch : directory;
        return <div className="shadow-worktree-row" key={tree.path} data-bound={checked} data-running={executing}>
          <button type="button" className="shadow-worktree-select" aria-pressed={checked} title={`${directory}\n${treeBranch}\n${tree.path}`}
            aria-label={`${root.name} · ${directory} · ${treeBranch}`} disabled={locked || running || tree.prunable}
            onClick={() => onBind(root, tree.path)}>
            <span className="shadow-worktree-check" title={checked ? zh ? '用户选择' : 'User selection' : undefined}>{checked && <Check size={12} />}</span>
            <span className="shadow-worktree-text"><span className="shadow-worktree-title">{executing && <span className="shadow-worktree-agent" role="img" aria-label={zh ? 'Agent 正在此目录运行' : 'Agent running in this directory'} title={zh ? 'Agent 正在此目录运行' : 'Agent running in this directory'}><Bot size={13} /></span>}<span className="shadow-worktree-name">{label}</span></span>
              {detail !== label && <span className="shadow-worktree-detail" title={detail}>{detail}</span>}
              {tree.prunable && <span className="shadow-worktree-unavailable">{zh ? '目录缺失' : 'Directory missing'}</span>}
            </span>
          </button>
          {!tree.primary && <button type="button" className="shadow-worktree-delete" disabled={locked}
            aria-label={`${zh ? '删除工作树' : 'Delete worktree'} ${directory}`}
            title={tree.prunable ? zh ? '清理缺失目录的工作树登记' : 'Remove missing worktree registration' : checked ? zh ? '当前会话正在使用，请先切换目录' : 'Switch away from this worktree before deleting' : zh ? '删除工作树' : 'Delete worktree'}
            onClick={() => onDelete(root, tree)}><Trash2 size={13} /></button>}
        </div>;
      })}
      {running && <p className="shadow-project-hint">{zh ? '执行结束后可切换工作树' : 'Switch worktrees after the run finishes'}</p>}
    </div>}
    {selected && root.status !== 'not_repository' && error && <p className="shadow-project-error" role="alert">{error}</p>}
  </div>;
});

export function WorkspaceProjectSwitcher({ sessionId, projectId, repositories, selectedRootId, onSelect, reload }: {
  sessionId: string; projectId: string; repositories: WorkspaceEnvironmentRepository[];
  selectedRootId: string; onSelect: (rootId: string) => void; reload: () => void | Promise<void>;
}) {
  const zh = useLocale().locale === 'zh';
  const [summaries, setSummaries] = useState<Record<string, GitWorkspaceSummary>>(() => Object.fromEntries(
    repositories.flatMap(root => { const value = cachedWorktreeInventory(projectId, root.rootId); return value ? [[root.rootId, value]] : []; }),
  ));
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [actionError, setActionError] = useState<{ rootId: string; text: string } | null>(null);
  const [notice, setNotice] = useState('');
  const [refresh, setRefresh] = useState(0);
  const consumedRefresh = useRef(0);
  const [binding, setBinding] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [deleteTarget, setDeleteTarget] = useState<{ root: WorkspaceEnvironmentRepository; tree: GitWorktreeSummary } | null>(null);
  const mounted = useRef(true);
  const bindingLock = useRef(false);
  const list = useRef<HTMLDivElement>(null);
  const session = useAgentSessionStore(state => state.sessions.find(item => item.id === sessionId));
  const running = Boolean(session?.activeRunId || (session && ['running', 'waiting_permission', 'waiting_input', 'paused'].includes(session.status)));
  const backend = session?.sessionMetadata?.backend as { userWorktrees?: Record<string, { path: string }>; rootWorktrees?: Record<string, { path: string }>; workDir?: string; executionRootId?: string; workspaceBindingRevision?: number } | undefined;
  const executionRootId = backend?.executionRootId ?? repositories.find(root => root.role === 'primary')?.rootId;
  const executionPath = running ? backend?.rootWorktrees?.[executionRootId ?? '']?.path ??
    (executionRootId === repositories.find(root => root.role === 'primary')?.rootId ? backend?.workDir : undefined) ??
    repositories.find(root => root.rootId === executionRootId)?.workspacePath : undefined;
  const rootsKey = JSON.stringify(repositories.map(root => [root.rootId, root.status]));
  const rootsRef = useRef(repositories);
  rootsRef.current = repositories;
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    if (backend?.workspaceBindingRevision || session?.sessionMetadata?.worktreesUpdatedAt) setRefresh(value => value + 1);
  }, [backend?.workspaceBindingRevision, session?.sessionMetadata?.worktreesUpdatedAt]);

  const publish = useCallback((rootId: string, value: GitWorkspaceSummary) => {
    setSummaries(previous => previous[rootId] === value ? previous : { ...previous, [rootId]: value });
    setErrors(previous => {
      if (!previous[rootId]) return previous;
      const next = { ...previous }; delete next[rootId]; return next;
    });
  }, []);
  useEffect(() => {
    let cancelled = false;
    const force = refresh !== consumedRefresh.current;
    consumedRefresh.current = refresh;
    const roots = rootsRef.current.filter(root => root.status !== 'not_repository');
    let next = 0;
    void Promise.all(Array.from({ length: Math.min(4, roots.length) }, async () => {
      while (next < roots.length && !cancelled) {
        const root = roots[next++];
        try {
          const summary = await loadWorktreeInventory(projectId, root.rootId, force);
          if (!cancelled) publish(root.rootId, summary);
        } catch (cause) {
          if (!cancelled) setErrors(previous => ({ ...previous, [root.rootId]: cause instanceof Error ? cause.message : String(cause) }));
        }
      }
    }));
    return () => { cancelled = true; };
  }, [projectId, rootsKey, refresh, publish]);

  // Selecting a project only revalidates that repository; never rescan all roots.
  useEffect(() => {
    let current = true;
    const root = rootsRef.current.find(item => item.rootId === selectedRootId);
    if (root && root.status !== 'not_repository') void loadWorktreeInventory(projectId, root.rootId).then(summary => {
      if (current) publish(root.rootId, summary);
    }).catch(() => {}); // The inventory pass supplies inline error/retry feedback.
    const row = list.current?.querySelector<HTMLElement>('[data-active="true"]');
    if (row && list.current) {
      const offset = row.getBoundingClientRect().top - list.current.getBoundingClientRect().top;
      if (offset < 0 || offset + row.offsetHeight > list.current.clientHeight) list.current.scrollTop += offset;
    }
    return () => { current = false; };
  }, [projectId, selectedRootId, publish]);
  useEffect(() => {
    const changed = (event: Event) => {
      const detail = (event as CustomEvent<{ projectId: string; rootId?: string }>).detail;
      if (detail?.projectId !== projectId) return;
      const rootId = detail.rootId ?? projectId;
      void loadWorktreeInventory(projectId, rootId).then(value => { if (mounted.current) publish(rootId, value); })
        .catch(cause => { if (mounted.current) setErrors(previous => ({ ...previous, [rootId]: String(cause) })); });
    };
    document.addEventListener(WORKTREES_CHANGED, changed);
    return () => document.removeEventListener(WORKTREES_CHANGED, changed);
  }, [projectId, publish]);

  const bind = useCallback(async (root: WorkspaceEnvironmentRepository, path: string) => {
    if (bindingLock.current || deleting || running) return;
    const currentSession = useAgentSessionStore.getState().sessions.find(item => item.id === sessionId);
    const userSelections = (currentSession?.sessionMetadata?.backend as { userWorktrees?: Record<string, { path: string }> } | undefined)?.userWorktrees;
    if (pathKey(path) === pathKey(root.workspacePath) && pathKey(path) === pathKey(userSelections?.[root.rootId]?.path ?? root.workspacePath)) return;
    const tabs = useSessionWorkspaceStore.getState().sessions[sessionId]?.tabs ?? [];
    const affected = tabs.filter(tab => tab.rootId === root.rootId || (!tab.rootId && root.role === 'primary'));
    if (affected.some(tab => tab.dirty)) {
      setActionError({ rootId: root.rootId, text: zh ? '请先保存该项目已打开文件的修改。' : 'Save this project’s open file edits before switching.' }); return;
    }
    bindingLock.current = true; setBinding(root.rootId); setActionError(null); setNotice('');
    try {
      await agentRuntimeApi.bindSessionWorktree(sessionId, { rootId: root.rootId, path, expectedPath: root.workspacePath });
      for (const tab of affected) useSessionWorkspaceStore.getState().closeTab(sessionId, tab.id);
      resetSessionWorkspaceGit(projectId, sessionId);
      invalidateSessionEnvironmentCards(sessionId);
      refreshWorkspace(sessionId, root.rootId);
      await reload();
    } catch (cause) {
      if (mounted.current) setActionError({ rootId: root.rootId, text: cause instanceof Error ? cause.message : String(cause) });
    } finally { bindingLock.current = false; if (mounted.current) setBinding(null); }
  }, [deleting, running, sessionId, projectId, reload, zh]);
  const deletionLock = useRef(false);
  const branchChanged = useCallback((rootId: string) => {
    invalidateWorktreeInventory(projectId, rootId);
    invalidateSessionEnvironmentCards(sessionId);
    void Promise.resolve(reload()).catch(cause => {
      if (mounted.current) setActionError({ rootId, text: cause instanceof Error ? cause.message : String(cause) });
    });
  }, [projectId, sessionId, reload]);
  const beginDelete = useCallback(async (root: WorkspaceEnvironmentRepository, tree: GitWorktreeSummary) => {
    if (deletionLock.current || bindingLock.current) return;
    setNotice(''); setActionError(null);
    if (!tree.prunable) { setDeleteTarget({ root, tree }); return; }
    deletionLock.current = true; setDeleting(true);
    try {
      await removeMissingWorktree(projectId, tree.path, root.rootId);
      if (!mounted.current) return;
      setSummaries(previous => {
        const summary = previous[root.rootId];
        return summary ? { ...previous, [root.rootId]: { ...summary, worktrees: summary.worktrees.filter(item => item.path !== tree.path) } } : previous;
      });
      setNotice(zh ? '缺失目录登记已清理，分支与提交已保留' : 'Missing registration removed. Branch and commits kept.');
    } catch (cause) {
      if (mounted.current) setActionError({ rootId: root.rootId, text: cause instanceof Error ? cause.message : String(cause) });
    } finally { deletionLock.current = false; if (mounted.current) setDeleting(false); }
  }, [projectId, zh]);

  return <section className="shadow-projects" aria-label={zh ? '工作区项目' : 'Workspace projects'}>
    <div className="shadow-project-list" ref={list}>
      {repositories.map(root => <ProjectRow key={root.rootId} sessionId={sessionId} root={root} summary={summaries[root.rootId]} selected={selectedRootId === root.rootId}
        locked={Boolean(binding) || deleting} running={running} zh={zh} error={actionError?.rootId === root.rootId ? actionError.text : errors[root.rootId]}
        userPath={backend?.userWorktrees?.[root.rootId]?.path} executionPath={root.rootId === executionRootId ? executionPath : undefined}
        onSelect={onSelect} onBind={bind} onDelete={beginDelete} onBranchChanged={branchChanged} />)}
    </div>
    {notice && <p className="shadow-project-notice" role="status">{notice}</p>}
    {deleteTarget && <WorktreeDeleteDialog key={deleteTarget.tree.path} projectId={projectId} rootId={deleteTarget.root.rootId} target={deleteTarget.tree}
      blockedReason={pathKey(deleteTarget.tree.path) === pathKey(deleteTarget.root.workspacePath)
        ? zh ? '当前会话正在使用此工作树，请先切换到主目录或其他工作树。' : 'This session uses this worktree. Select another directory before deleting it.' : undefined}
      onClose={() => setDeleteTarget(null)} onBusy={setDeleting}
      onDeleted={() => {
        setSummaries(previous => {
          const summary = previous[deleteTarget.root.rootId];
          return summary ? { ...previous, [deleteTarget.root.rootId]: { ...summary, worktrees: summary.worktrees.filter(tree => tree.path !== deleteTarget.tree.path) } } : previous;
        });
        setDeleteTarget(null); setNotice(zh ? '工作树已删除，分支与提交已保留' : 'Worktree deleted. Branch and commits kept.');
        refreshWorkspace(sessionId, deleteTarget.root.rootId);
        void Promise.resolve(reload()).catch(() => {});
      }} />}
  </section>;
}
