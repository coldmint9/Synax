import { useEffect, useState } from "react";
import {
  CheckCircle2,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  RefreshCw,
} from "lucide-react";
import {
  agentRuntimeApi,
  type AgentSession,
  type SessionGitBranches,
} from "../../../adapters/transport/agentRuntime";
import { conversationGitApi } from "../../../adapters/transport/conversationGit";
import { Button } from "../../../shared/ui/ui/Button";
import { Field, Label, Input, TextArea } from "../../../shared/ui/ui/Field";
import { Select } from "../../../shared/ui/ui/Select";
import { Checkbox } from "../../../shared/ui/ui/Toggle";
import { useAgentSessionStore } from "../state/agentSessionStore";
import { refreshWorkspace } from "../workspaceRefresh";
export default function LocalGitPanel({
  session,
  rootId,
  onBusy,
  onTaskReady,
}: {
  session: AgentSession;
  rootId: string;
  onBusy: (value: boolean) => void;
  onTaskReady: () => void;
}) {
  const [data, setData] = useState<SessionGitBranches | null>(null);
  const [message, setMessage] = useState("");
  const [includeUntracked, setIncludeUntracked] = useState(true);
  const [newBranch, setNewBranch] = useState("");
  const [switchTo, setSwitchTo] = useState<string | null>(null);
  const [target, setTarget] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [result, setResult] = useState("");
  const [allowTarget, setAllowTarget] = useState(false);
  const load = async () => {
    const next = await agentRuntimeApi.listSessionBranches(session.id, rootId);
    setData(next);
    setSwitchTo(next.current || null);
    setTarget(
      (current) =>
        current ??
        (next.branches.some((b) => b.name === "main")
          ? "main"
          : next.branches.some((b) => b.name === "master")
            ? "master"
            : null),
    );
  };
  useEffect(() => {
    let active = true;
    void agentRuntimeApi
      .listSessionBranches(session.id, rootId)
      .then((next) => {
        if (active) {
          setData(next);
          setSwitchTo(next.current || null);
          setTarget(
            next.branches.find((b) => b.name === "main" || b.name === "master")
              ?.name ?? null,
          );
        }
      })
      .catch((e) => {
        if (active) setError(e.message);
      });
    return () => {
      active = false;
    };
  }, [session.id, rootId]);
  const perform = async (work: () => Promise<void>) => {
    if (busy) return;
    setBusy(true);
    onBusy(true);
    setError("");
    setResult("");
    try {
      await work();
      refreshWorkspace(session.id, rootId);
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      onBusy(false);
    }
  };
  const locked =
    busy ||
    Boolean(session.activeRunId) ||
    ["running", "waiting_permission", "queued"].includes(session.status);
  return (
    <div className="git-action-panel">
      {error && (
        <p role="alert" className="git-actions-error">
          {error}
        </p>
      )}
      {result && (
        <p role="status" className="git-actions-success">
          <CheckCircle2 size={14} />
          {result}
        </p>
      )}
      {data ? (
        <>
          <div className="git-actions-repo-line">
            <GitBranch size={14} />
            <code>{data.current || "Detached HEAD"}</code>
            <span>{data.dirtyFileCount} 个文件有改动</span>
            <Button
              iconOnly
              size="xs"
              variant="ghost"
              aria-label="刷新本地状态"
              disabled={busy}
              onClick={() => void perform(async () => {})}
            >
              <RefreshCw size={13} />
            </Button>
          </div>
          {locked && !busy && (
            <p className="git-actions-description">
              Agent 正在使用工作区，请等待当前操作结束后处理分支。
            </p>
          )}
          <Field>
            <Label>提交说明</Label>
            <TextArea
              rows={3}
              value={message}
              onChange={(e) => setMessage(e.target.value)}
              placeholder="描述本次本地改动…"
              disabled={locked}
            />
          </Field>
          {!data.current && (
            <Field>
              <Label>为当前提交命名分支</Label>
              <Input
                value={newBranch}
                onChange={(e) => setNewBranch(e.target.value)}
                placeholder="feature/my-change"
                disabled={locked}
              />
            </Field>
          )}
          <label className="git-actions-checkbox">
            <Checkbox
              checked={includeUntracked}
              onChange={setIncludeUntracked}
              disabled={locked}
            />
            包含未跟踪文件
          </label>
          <Button
            variant="primary"
            disabled={
              locked ||
              !message.trim() ||
              data.dirtyFileCount === 0 ||
              (!data.current && !newBranch.trim())
            }
            onClick={() =>
              void perform(async () => {
                const committed = await agentRuntimeApi.commitSessionWorkspace(
                  session.id,
                  {
                    rootId,
                    message,
                    includeUntracked,
                    push: false,
                    ...(!data.current ? { branchName: newBranch.trim() } : {}),
                  },
                );
                setMessage("");
                setResult(
                  `已提交到 ${committed.branch} · ${committed.commitSha.slice(0, 8)}，尚未推送远程。`,
                );
              })
            }
          >
            <GitCommitHorizontal size={14} />
            Commit 到本地
          </Button>
          <details className="git-actions-details">
            <summary>本地分支</summary>
            <div className="git-actions-fields">
              <Select
                label="切换分支"
                value={switchTo}
                onChange={setSwitchTo}
                disabled={locked}
                options={data.branches.map((branch) => ({
                  value: branch.name,
                  label: branch.name,
                  disabled: branch.occupied,
                }))}
              />
              <Button
                disabled={
                  locked ||
                  !switchTo ||
                  switchTo === data.current ||
                  data.dirtyFileCount > 0
                }
                onClick={() =>
                  void perform(async () => {
                    await agentRuntimeApi.switchSessionBranch(
                      session.id,
                      switchTo!,
                      rootId,
                    );
                    setResult(`已切换到 ${switchTo}`);
                  })
                }
              >
                切换分支
              </Button>
              <Field>
                <Label>新建分支（feature 从生产基线创建）</Label>
                <Input
                  value={newBranch}
                  onChange={(e) => setNewBranch(e.target.value)}
                  placeholder="feature/my-change"
                  disabled={locked}
                />
              </Field>
              <Button
                disabled={
                  locked || !newBranch.trim() || data.dirtyFileCount > 0
                }
                onClick={() =>
                  void perform(async () => {
                    await agentRuntimeApi.createSessionBranch(
                      session.id,
                      newBranch.trim(),
                      rootId,
                    );
                    setResult(`已创建 ${newBranch.trim()}`);
                    setNewBranch("");
                  })
                }
              >
                创建并切换
              </Button>
              {data.dirtyFileCount > 0 && (
                <small>请先提交改动，再切换或创建分支。</small>
              )}
            </div>
          </details>
          <details className="git-actions-details">
            <summary>分析本地合并</summary>
            <div className="git-actions-fields">
              <p className="git-actions-description">
                将当前分支作为来源，在隔离工作树中分析；最后由你确认更新目标。
              </p>
              <Select
                label="目标分支"
                value={target}
                onChange={setTarget}
                disabled={locked}
                options={data.branches
                  .filter((branch) => branch.name !== data.current)
                  .map((branch) => ({
                    value: branch.name,
                    label: branch.name,
                  }))}
              />
              <label className="git-actions-checkbox">
                <Checkbox
                  checked={allowTarget}
                  onChange={setAllowTarget}
                  disabled={locked}
                />
                允许最终确认后更新已检出的干净目标工作树
              </label>
              <Button
                disabled={
                  locked || !target || !data.current || target === data.current
                }
                onClick={() =>
                  void perform(async () => {
                    const snapshot = await conversationGitApi.create(
                      session.id,
                      {
                        requestId: crypto.randomUUID(),
                        rootId,
                        title: `合并 ${data.current} 到 ${target}`,
                        target: target!,
                        sources: [data.current],
                        strategy: "merge_commit",
                        checks: [],
                        allowCheckedOutTarget: allowTarget,
                      },
                    );
                    useAgentSessionStore
                      .getState()
                      .ingestConversationMessages(
                        session.id,
                        snapshot.messages,
                      );
                    onTaskReady();
                  })
                }
              >
                <GitMerge size={14} />
                创建可视化合并任务
              </Button>
            </div>
          </details>
        </>
      ) : (
        <p role="status">正在读取本地 Git 状态…</p>
      )}
    </div>
  );
}
