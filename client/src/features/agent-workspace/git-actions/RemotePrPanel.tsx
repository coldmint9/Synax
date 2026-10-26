import { useEffect, useRef, useState } from "react";
import { Link } from 'react-router-dom';
import { ArrowUpRight, GitPullRequest, RefreshCw, Upload } from "lucide-react";
import {
  remotePrApi,
  type RemotePrDiscovery,
  type RemotePullRequest,
  type RemotePrSnapshot,
  type PrProvider,
} from "../../../adapters/transport/remotePr";
import { Button } from "../../../shared/ui/ui/Button";
import { Field, Label, Input, TextArea } from "../../../shared/ui/ui/Field";
import { Select } from "../../../shared/ui/ui/Select";
import { Checkbox } from "../../../shared/ui/ui/Toggle";
import { useAgentSessionStore } from "../state/agentSessionStore";
import { refreshWorkspace } from "../workspaceRefresh";
export default function RemotePrPanel({
  sessionId,
  rootId,
  onBusy,
  onTaskReady,
}: {
  sessionId: string;
  rootId: string;
  onBusy: (value: boolean) => void;
  onTaskReady: () => void;
}) {
  const [data, setData] = useState<RemotePrDiscovery | null>(null);
  const [remote, setRemote] = useState<string | null>(null);
  const [provider, setProvider] = useState<PrProvider>("github");
  const [items, setItems] = useState<RemotePullRequest[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [page, setPage] = useState(1);
  const [hasMore, setHasMore] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [head, setHead] = useState("");
  const [base, setBase] = useState("main");
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [draft, setDraft] = useState(true);
  const [number, setNumber] = useState("");
  const [pushConfirm, setPushConfirm] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const version = ++generation.current;
    void remotePrApi
      .discover(sessionId, rootId)
      .then((next) => {
        if (version !== generation.current) return;
        setData(next);
        setHead(next.branch);
        setTitle(next.branch);
        const first =
          next.remotes.find(
            (item) => item.name === "origin" && !item.unsupportedReason,
          ) ?? next.remotes.find((item) => !item.unsupportedReason);
        setRemote(first?.name ?? null);
        if (first?.provider) setProvider(first.provider);
        setBase(
          next.branches.includes("main")
            ? "main"
            : next.branches.includes("master")
              ? "master"
              : "",
        );
      })
      .catch((e) => {
        if (version === generation.current) setError(e.message);
      });
    return () => {
      generation.current++;
    };
  }, [sessionId, rootId]);
  const scope = { rootId, remote: remote ?? "", provider };
  const finish = (snapshot: RemotePrSnapshot) => {
    useAgentSessionStore
      .getState()
      .ingestConversationMessages(sessionId, snapshot.messages);
    onTaskReady();
  };
  const perform = async (work: () => Promise<void>) => {
    if (busy) return;
    const version = generation.current;
    setBusy(true);
    onBusy(true);
    setError("");
    setNotice("");
    try {
      await work();
      refreshWorkspace(sessionId, rootId);
    } catch (e) {
      if (version === generation.current)
        setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (version === generation.current) setBusy(false);
      onBusy(false);
    }
  };
  const load = async (nextPage = 1) => {
    const result = await remotePrApi.list(sessionId, scope, nextPage);
    setItems(result.items);
    setLoaded(true);
    setPage(nextPage);
    setHasMore(result.hasMore);
  };
  return (
    <div className="git-action-panel">
      {error && (
        <p className="git-actions-error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="git-actions-success" role="status">
          {notice}
        </p>
      )}
      {!data ? (
        <p role="status">正在读取 remote…</p>
      ) : (
        <>
          {!data.remotes.length ? (
            <p>
              尚未配置远程仓库。先为本地仓库添加 GitHub 或 GitLab remote，再打开
              PR。
            </p>
          ) : (
            <>
              <div className="git-actions-two-columns">
                <Select
                  label="远程仓库"
                  value={remote}
                  disabled={busy}
                  options={data.remotes.map((item) => ({
                    value: item.name,
                    label: `${item.name}${item.path ? ` · ${item.path}` : ""}`,
                    disabled: Boolean(item.unsupportedReason),
                  }))}
                  onChange={(name) => {
                    setRemote(name);
                    const next = data.remotes.find(
                      (item) => item.name === name,
                    );
                    if (next?.provider) setProvider(next.provider);
                    setItems([]);
                    setLoaded(false);
                    setPushConfirm(false);
                  }}
                />
                <Select
                  label="平台"
                  value={provider}
                  onChange={(value) => {
                    setProvider(value as PrProvider);
                    setItems([]);
                    setLoaded(false);
                  }}
                  disabled={
                    busy ||
                    Boolean(
                      data.remotes.find((item) => item.name === remote)
                        ?.provider,
                    )
                  }
                  options={[
                    { value: "github", label: "GitHub · PR" },
                    { value: "gitlab", label: "GitLab · MR" },
                  ]}
                />
              </div>
              <p className="git-actions-description">
                {provider === 'github' ? '使用本机 gh 的登录凭据。支持对应平台的私有主机，凭据不会保存到对话。' : <>
                  使用 Synax 内置 GitLab 连接和已保存的登录凭据。
                  <Link className="text-primary underline" to="/settings?section=gitLab">配置 GitLab 登录</Link>
                </>}
              </p>
              <div className="git-actions-toolbar">
                <Button
                  disabled={busy || !remote}
                  onClick={() => void perform(() => load())}
                >
                  <RefreshCw size={13} />
                  读取远程请求
                </Button>
                <span>{loaded ? `${items.length} 个开放请求` : ""}</span>
              </div>
              {loaded && (
                <div className="git-actions-pr-list">
                  {items.map((pr) => (
                    <button
                      key={pr.number}
                      disabled={busy}
                      onClick={() =>
                        void perform(async () =>
                          finish(
                            await remotePrApi.attach(sessionId, {
                              ...scope,
                              requestId: crypto.randomUUID(),
                              number: pr.number,
                            }),
                          ),
                        )
                      }
                    >
                      <GitPullRequest size={15} />
                      <div>
                        <strong>
                          #{pr.number} {pr.title}
                        </strong>
                        <small>
                          {pr.head} → {pr.base}
                          {pr.draft ? " · 草稿" : ""}
                        </small>
                      </div>
                      <ArrowUpRight size={14} />
                    </button>
                  ))}
                  {!items.length && (
                    <p>
                      当前没有开放的 {provider === "github" ? "PR" : "MR"}。
                    </p>
                  )}
                  <div className="git-actions-toolbar">
                    <Button
                      size="xs"
                      disabled={busy || page === 1}
                      onClick={() => void perform(() => load(page - 1))}
                    >
                      上一页
                    </Button>
                    <span>第 {page} 页</span>
                    <Button
                      size="xs"
                      disabled={busy || !hasMore}
                      onClick={() => void perform(() => load(page + 1))}
                    >
                      下一页
                    </Button>
                  </div>
                </div>
              )}
              <details className="git-actions-details">
                <summary>按编号打开已有 PR / MR</summary>
                <div className="git-actions-toolbar">
                  <Input
                    type="number"
                    min={1}
                    aria-label="远程请求编号"
                    value={number}
                    onChange={(e) => setNumber(e.target.value)}
                  />
                  <Button
                    disabled={
                      busy ||
                      !remote ||
                      !Number.isSafeInteger(Number(number)) ||
                      Number(number) < 1
                    }
                    onClick={() =>
                      void perform(async () =>
                        finish(
                          await remotePrApi.attach(sessionId, {
                            ...scope,
                            requestId: crypto.randomUUID(),
                            number: Number(number),
                          }),
                        ),
                      )
                    }
                  >
                    打开
                  </Button>
                </div>
              </details>
              <details className="git-actions-details">
                <summary>
                  创建{" "}
                  {provider === "github" ? "Pull Request" : "Merge Request"}
                </summary>
                <div className="git-actions-fields">
                  <div className="git-actions-two-columns">
                    <Field>
                      <Label>来源分支（远程）</Label>
                      <Input
                        value={head}
                        onChange={(e) => setHead(e.target.value)}
                        disabled={busy}
                      />
                    </Field>
                    <Field>
                      <Label>目标分支（远程）</Label>
                      <Input
                        value={base}
                        onChange={(e) => setBase(e.target.value)}
                        disabled={busy}
                      />
                    </Field>
                  </div>
                  <Field>
                    <Label>标题</Label>
                    <Input
                      value={title}
                      onChange={(e) => setTitle(e.target.value)}
                      disabled={busy}
                    />
                  </Field>
                  <Field>
                    <Label>说明</Label>
                    <TextArea
                      rows={3}
                      value={body}
                      onChange={(e) => setBody(e.target.value)}
                      disabled={busy}
                    />
                  </Field>
                  <label className="git-actions-checkbox">
                    <Checkbox
                      checked={draft}
                      onChange={setDraft}
                      disabled={busy}
                    />
                    创建为草稿
                  </label>
                  <p className="git-actions-description">
                    创建使用已经推送到所选远程的分支。此操作会在远程平台发布标题和说明。
                  </p>
                  <Button
                    variant="primary"
                    disabled={
                      busy ||
                      !remote ||
                      !title.trim() ||
                      !head ||
                      !base ||
                      head === base
                    }
                    onClick={() =>
                      void perform(async () =>
                        finish(
                          await remotePrApi.create(sessionId, {
                            ...scope,
                            requestId: crypto.randomUUID(),
                            title: title.trim(),
                            body,
                            head,
                            base,
                            draft,
                          }),
                        ),
                      )
                    }
                  >
                    <GitPullRequest size={14} />在{" "}
                    {provider === "github" ? "GitHub" : "GitLab"} 创建
                    {draft ? "草稿" : ""} {provider === "github" ? "PR" : "MR"}
                  </Button>
                </div>
              </details>
              <details className="git-actions-details">
                <summary>推送当前本地分支</summary>
                <p className="git-actions-description">
                  <code>{data.branch || "Detached HEAD"}</code> →{" "}
                  <code>{remote}</code>。仅普通推送，不覆盖远程已有历史。
                </p>
                {data.dirty && (
                  <p className="git-actions-description">
                    工作区仍有改动，请先通过 Commit 提交。
                  </p>
                )}
                <label className="git-actions-checkbox">
                  <Checkbox
                    checked={pushConfirm}
                    onChange={setPushConfirm}
                    disabled={busy}
                  />
                  确认把当前分支提交上传到所选远程
                </label>
                <Button
                  disabled={
                    busy ||
                    !remote ||
                    !data.branch ||
                    data.dirty ||
                    !pushConfirm
                  }
                  onClick={() =>
                    void perform(async () => {
                      setData(
                        await remotePrApi.push(sessionId, {
                          ...scope,
                          expectedLocalHead: data.headSha,
                          branch: data.branch,
                        }),
                      );
                      setPushConfirm(false);
                      setNotice("分支已推送，可继续创建 PR / MR。");
                    })
                  }
                >
                  <Upload size={13} />
                  确认推送 {data.branch}
                </Button>
              </details>
            </>
          )}
        </>
      )}
    </div>
  );
}
