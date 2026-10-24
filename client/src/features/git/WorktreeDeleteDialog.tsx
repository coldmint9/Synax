import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Trash2, TriangleAlert } from 'lucide-react';
import { projectApi, type GitWorktreeSummary } from '../../adapters/transport/project';
import { cleanupReasons, WORKTREE_DIRTY_REASON, type GitWorktreeChanges } from '../../../../services/local-node/modules/git-worktree-management-contracts';
import { Dialog, DialogBody, DialogContainer, DialogFooter, DialogPanel, DialogTitle } from '../../shared/ui/ui/Dialog';
import { Button } from '../../shared/ui/ui/Button';
import { useLocale } from '../../shared/hooks/useLocale';
import { invalidateWorktreeInventory } from './worktreeInventory';
import './worktreeDeleteDialog.css';

/** Shared by the Git workbench and the conversation's inline worktree rows. */
export function WorktreeDeleteDialog({ projectId, rootId, target, blockedReason, onClose, onDeleted, onBusy }: {
  projectId: string;
  rootId?: string;
  target: GitWorktreeSummary;
  blockedReason?: string;
  onClose: () => void;
  onDeleted: (path: string) => void;
  onBusy?: (busy: boolean) => void;
}) {
  const zh = useLocale().locale === 'zh';
  const [checked, setChecked] = useState<GitWorktreeSummary | null>(null);
  const [checking, setChecking] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [discard, setDiscard] = useState<GitWorktreeChanges | null>(null);
  const [inspecting, setInspecting] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const locked = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let current = true;
    setChecking(true); setChecked(null); setError(''); setConfirming(false); setDiscard(null);
    if (blockedReason) { setChecking(false); return; }
    void projectApi.listGitWorkspaces(projectId, rootId).then(summary => {
      if (!current) return;
      const worktree = summary.worktrees.find(item => item.path === target.path);
      if (!worktree) throw new Error(zh ? '工作树已不存在，请刷新项目列表。' : 'This worktree no longer exists. Refresh the project list.');
      setChecked(worktree);
    }).catch(cause => { if (current) setError(cause instanceof Error ? cause.message : String(cause)); })
      .finally(() => { if (current) setChecking(false); });
    return () => { current = false; };
  }, [projectId, rootId, target.path, blockedReason, attempt, zh]);
  const reasons = blockedReason ? [blockedReason] : checked ? cleanupReasons(checked) : [];
  // Only uncommitted work may be discarded on request; every other guard stays absolute.
  const discardable = !blockedReason && reasons.length === 1 && reasons[0] === WORKTREE_DIRTY_REASON;
  const title = target.branch ?? `${zh ? '游离 HEAD' : 'Detached HEAD'} · ${target.head.slice(0, 8)}`;
  async function inspect() {
    if (locked.current || inspecting || busy || checking) return;
    locked.current = true; setInspecting(true); setError('');
    try {
      const changes = await projectApi.gitWorktreeChanges(projectId, target.path, rootId);
      if (!mounted.current) return;
      if (!changes.total) {
        setError(zh ? '这个工作树已经没有本地修改了，请重新检查后再删除。' : 'This worktree has no local changes anymore. Check again before deleting.');
        return;
      }
      setDiscard(changes); setConfirming(true);
    } catch (cause) {
      if (mounted.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      locked.current = false;
      if (mounted.current) setInspecting(false);
    }
  }
  async function remove(force: boolean) {
    if (locked.current || checking || !checked || (!force && reasons.length)) return;
    locked.current = true; setBusy(true); setError(''); onBusy?.(true);
    try {
      await projectApi.removeGitWorktree(projectId, { path: target.path, rootId, force });
    } catch (cause) {
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
        setConfirming(false); setDiscard(null);
        setChecked(null); // A failed request must be rechecked before a retry.
      }
      return;
    } finally {
      locked.current = false;
      if (mounted.current) setBusy(false);
      onBusy?.(false);
    }
    invalidateWorktreeInventory(projectId, rootId);
    if (mounted.current) onDeleted(target.path);
  }
  const heading = reasons.length
    ? confirming
      ? zh ? '丢弃本地修改并删除工作树？' : 'Discard local changes and delete?'
      : zh ? '暂时无法删除工作树' : 'Worktree cannot be deleted'
    : zh ? '删除工作树？' : 'Delete worktree?';
  return <Dialog open onClose={onClose} dismissible={!busy}>
    <DialogContainer size="sm"><DialogPanel className="worktree-delete-dialog">
      <DialogTitle>{heading}</DialogTitle>
      <DialogBody>
        <div className="worktree-delete-target"><strong>{title}</strong><code>{target.path}</code></div>
        {checking ? <p className="worktree-delete-status" role="status"><LoaderCircle size={14} className="animate-spin" />{zh ? '正在检查修改和会话占用…' : 'Checking changes and session usage…'}</p>
          : reasons.length ? <ul className="worktree-delete-reasons">{reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
          : checked ? <p className="worktree-delete-explanation">{zh ? '将删除工作目录与工作树登记。分支、提交和历史会话保留。删除无法撤销。' : 'Deletes the checkout and worktree registration. Branches, commits and session history are kept. This cannot be undone.'}</p> : null}
        {confirming && discard && <div className="worktree-delete-discard" role="group" aria-label={zh ? '将被丢弃的修改' : 'Changes to discard'}>
          <p><TriangleAlert size={14} aria-hidden="true" />{zh
            ? `将永久丢弃 ${discard.total} 处本地修改（含未跟踪文件），删除后无法恢复。`
            : `${discard.total} local change${discard.total === 1 ? '' : 's'} (including untracked files) will be discarded permanently.`}</p>
          <ul className="worktree-delete-changes">{discard.entries.map(entry => <li key={`${entry.code}:${entry.path}`}><span>{entry.code}</span><code>{entry.path}</code></li>)}</ul>
          {discard.truncated && <p className="worktree-delete-truncated">{zh ? `仅列出前 ${discard.entries.length} 项，仍有其他修改会被一并丢弃。` : `Showing the first ${discard.entries.length}; other changes are discarded too.`}</p>}
          <p className="worktree-delete-truncated">{zh ? '分支、提交和历史会话仍会保留。' : 'Branches, commits and session history are still kept.'}</p>
        </div>}
        {error && <p className="worktree-delete-error" role="alert">{error}</p>}
      </DialogBody>
      <DialogFooter>
        {confirming ? <>
          <Button disabled={busy} onClick={() => { setConfirming(false); setDiscard(null); setError(''); }}>{zh ? '返回' : 'Back'}</Button>
          <Button variant="danger" pending={busy} disabled={busy} onClick={() => void remove(true)}><Trash2 size={14} />{zh ? `确认丢弃 ${discard?.total ?? 0} 处修改并删除` : `Discard ${discard?.total ?? 0} and delete`}</Button>
        </> : <>
          <Button disabled={busy} onClick={onClose}>{zh ? '取消' : 'Cancel'}</Button>
          {error && !checking && <Button variant="secondary" onClick={() => setAttempt(value => value + 1)}>{zh ? '重新检查' : 'Check again'}</Button>}
          {discardable && <Button variant="secondary" pending={inspecting} disabled={checking || !checked || busy || inspecting} onClick={() => void inspect()}>{zh ? '强制删除（丢弃修改）…' : 'Force delete (discard changes)…'}</Button>}
          {!reasons.length && <Button variant="danger" pending={busy} disabled={checking || !checked || busy} onClick={() => void remove(false)}><Trash2 size={14} />{zh ? '删除工作树' : 'Delete worktree'}</Button>}
        </>}
      </DialogFooter>
    </DialogPanel></DialogContainer>
  </Dialog>;
}
