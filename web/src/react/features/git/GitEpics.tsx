import { useState } from "react";
import { Link } from "react-router-dom";
import { projectApi } from "../../../lib/api/project";
import type { GitAssociations, GitEpic } from "../../../../../api/services/git-epic-contracts";
import { Dialog, DialogBody, DialogPanel, DialogTitle, DialogFooter } from "../../components/ui/Dialog";
import { Button } from "../../components/ui/Button";
import { sessionPath } from "../agent-workspace/sessionRoutes";

export function GitEpicPanel({ projectId, rootId, data, onRefresh }: { projectId: string; rootId?: string; data: GitAssociations; onRefresh: () => void }) {
  const [editing, setEditing] = useState<Partial<GitEpic> | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const save = async () => {
    if (!editing?.name?.trim()) return;
    setBusy(true); setError("");
    try {
      await projectApi.saveGitEpic(projectId, { rootId, id: editing.id, expectedVersion: editing.version, name: editing.name, description: editing.description ?? "", refs: editing.refs ?? [], sessionIds: editing.sessionIds ?? [], archived: editing.archived ?? false });
      setEditing(null); onRefresh();
    } catch (err) { setError(err instanceof Error ? err.message : String(err)); }
    finally { setBusy(false); }
  };
  const toggle = (key: "refs" | "sessionIds", value: string) => setEditing(current => {
    if (!current) return current;
    const values = current[key] ?? [];
    return { ...current, [key]: values.includes(value) ? values.filter(item => item !== value) : [...values, value] };
  });
  return <details className="git-epic-panel"><summary>Epics · {data.epics.filter(item => !item.archived).length}</summary>
    <div className="git-epic-list">{data.epics.map(epic => <button key={epic.id} onClick={() => { setError(""); setEditing({ ...epic, sessionIds: epic.sessionIds.filter(id => data.sessions.some(session => session.id === id)) }); }}>{epic.name}{epic.archived ? " · 已归档" : ""} · {epic.refs.length} 分支</button>)}<Button size="sm" onClick={() => { setError(""); setEditing({ name: "", refs: [], sessionIds: [] }); }}>新建 Epic</Button></div>
    {editing && <Dialog open onClose={() => setEditing(null)} dismissible={!busy}><DialogPanel><DialogTitle>{editing.id ? "编辑 Epic" : "新建 Epic"}</DialogTitle><DialogBody>
      <label className="git-epic-field">名称<input maxLength={160} value={editing.name ?? ""} onChange={event => setEditing({ ...editing, name: event.target.value })} /></label>
      <label className="git-epic-field">描述<textarea value={editing.description ?? ""} onChange={event => setEditing({ ...editing, description: event.target.value })} /></label>
      <fieldset><legend>关联分支</legend><div className="git-epic-options">{data.refs.map(ref => <label key={ref.fullName}><input type="checkbox" checked={editing.refs?.includes(ref.fullName) ?? false} onChange={() => toggle("refs", ref.fullName)} />{ref.fullName.replace(/^refs\//, "")}</label>)}{editing.refs?.filter(ref => !data.refs.some(item => item.fullName === ref)).map(ref => <label key={ref}><input type="checkbox" checked onChange={() => toggle("refs", ref)} />{ref}（已不存在）</label>)}</div></fieldset>
      <fieldset><legend>关联未归档会话</legend><div className="git-epic-options">{data.sessions.map(session => <label key={session.id}><input type="checkbox" checked={editing.sessionIds?.includes(session.id) ?? false} onChange={() => toggle("sessionIds", session.id)} />{session.title || session.id}</label>)}</div></fieldset>
      <label><input type="checkbox" checked={editing.archived ?? false} onChange={event => setEditing({ ...editing, archived: event.target.checked })} />归档 Epic</label>
      {error && <p role="alert">{error}</p>}
    </DialogBody><DialogFooter><Button disabled={busy} onClick={() => setEditing(null)}>取消</Button><Button disabled={busy || !editing.name?.trim()} onClick={() => void save()}>{busy ? "保存中…" : "保存"}</Button></DialogFooter></DialogPanel></Dialog>}
  </details>;
}

export function GitBranchSessions({ projectId, data, fullRef }: { projectId: string; data: GitAssociations; fullRef: string }) {
  const [open, setOpen] = useState(false);
  const links = data.branches.find(branch => branch.ref === fullRef);
  const sessions = links?.sessions ?? [];
  return <><button className="git-branch-session-count" title={`${fullRef} 的未归档会话`} aria-label={`${fullRef}：${sessions.length} 个未归档会话`} onClick={() => setOpen(true)}>{sessions.length}</button>
    <Dialog open={open} onClose={() => setOpen(false)}><DialogPanel><DialogTitle>{fullRef.replace(/^refs\/(heads|remotes)\//, "")} · 未归档会话</DialogTitle><DialogBody>
      {links?.epicIds.map(id => <span className="history-tree-ref" key={id}>{data.epics.find(epic => epic.id === id)?.name}</span>)}
      {sessions.length ? <ul className="git-linked-sessions">{sessions.map(session => <li key={session.id}><Link to={sessionPath(projectId, session.id)}>{session.title || session.id}</Link><span>{session.status}</span></li>)}</ul> : <p>没有关联的未归档会话。</p>}
    </DialogBody><DialogFooter><Button onClick={() => setOpen(false)}>关闭</Button></DialogFooter></DialogPanel></Dialog>
  </>;
}

export function BranchSessionsDialog({ projectId, data, branch, onClose }: { projectId: string; data: GitAssociations; branch: string; onClose: () => void }) {
  const links = data.branches.find(item => item.ref === branch);
  return <Dialog open onClose={onClose}><DialogPanel><DialogTitle>{branch} · 未归档会话</DialogTitle><DialogBody>
    {links?.epicIds.map(id => <span className="history-tree-ref" key={id}>{data.epics.find(epic => epic.id === id)?.name}</span>)}
    {links?.sessions.length ? <ul className="git-linked-sessions">{links.sessions.map(session => <li key={session.id}><Link to={sessionPath(projectId, session.id)}>{session.title || session.id}</Link><span>{session.status}</span></li>)}</ul> : <p>没有关联的未归档会话。</p>}
  </DialogBody><DialogFooter><Button onClick={onClose}>关闭</Button></DialogFooter></DialogPanel></Dialog>;
}
