import { useEffect, useRef, useState } from 'react';
import { LoaderCircle, Trash2 } from 'lucide-react';
import { projectApi, type GitWorktreeSummary } from '../../adapters/transport/project';
import { cleanupReasons } from '../../../../services/local-node/modules/git-worktree-management-contracts';
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
  const locked = useRef(false);
  const mounted = useRef(true);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  useEffect(() => {
    let current = true;
    setChecking(true); setChecked(null); setError('');
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
  const title = target.branch ?? `${zh ? '游离 HEAD' : 'Detached HEAD'} · ${target.head.slice(0, 8)}`;
  async function remove() {
    if (locked.current || checking || !checked || reasons.length) return;
    locked.current = true; setBusy(true); setError(''); onBusy?.(true);
    try {
      await projectApi.removeGitWorktree(projectId, { path: target.path, rootId });
    } catch (cause) {
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
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
  return <Dialog open onClose={onClose} dismissible={!busy}>
    <DialogContainer size="sm"><DialogPanel className="worktree-delete-dialog">
      <DialogTitle>{reasons.length ? zh ? '暂时无法删除工作树' : 'Worktree cannot be deleted' : zh ? '删除工作树？' : 'Delete worktree?'}</DialogTitle>
      <DialogBody>
        <div className="worktree-delete-target"><strong>{title}</strong><code>{target.path}</code></div>
        {checking ? <p className="worktree-delete-status" role="status"><LoaderCircle size={14} className="animate-spin" />{zh ? '正在检查修改和会话占用…' : 'Checking changes and session usage…'}</p>
          : reasons.length ? <ul className="worktree-delete-reasons">{reasons.map(reason => <li key={reason}>{reason}</li>)}</ul>
          : checked ? <p className="worktree-delete-explanation">{zh ? '将删除工作目录与工作树登记。分支、提交和历史会话保留。删除无法撤销。' : 'Deletes the checkout and worktree registration. Branches, commits and session history are kept. This cannot be undone.'}</p> : null}
        {error && <p className="worktree-delete-error" role="alert">{error}</p>}
      </DialogBody>
      <DialogFooter><Button disabled={busy} onClick={onClose}>{zh ? '取消' : 'Cancel'}</Button>
        {error && !checking && <Button variant="secondary" onClick={() => setAttempt(value => value + 1)}>{zh ? '重新检查' : 'Check again'}</Button>}
        {!reasons.length && <Button variant="danger" pending={busy} disabled={checking || !checked || busy} onClick={() => void remove()}><Trash2 size={14} />{zh ? '删除工作树' : 'Delete worktree'}</Button>}
      </DialogFooter>
    </DialogPanel></DialogContainer>
  </Dialog>;
}
