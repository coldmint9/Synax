import { useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router-dom";
import {
  ArrowRight,
  ChevronRight,
  GitBranch,
  GitMerge,
  LoaderCircle,
  RefreshCw,
  Upload,
} from "lucide-react";
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
import { mergeRequestRef, mergeRequestTerms } from "./mrTerms";
import "./mergeRequest.css";

export default function MergeRequestPanel({
  sessionId,
  rootId,
  onBusy,
  onTaskReady,
  onProvider,
}: {
  sessionId: string;
  rootId: string;
  onBusy: (value: boolean) => void;
  onTaskReady: () => void;
  onProvider?: (provider: PrProvider | null) => void;
}) {
  const [data, setData] = useState<RemotePrDiscovery | null>(null);
  const [remote, setRemote] = useState<string | null>(null);
  const [provider, setProvider] = useState<PrProvider | null>(null);
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
  // Bumped whenever the list scope changes: a response for the previous remote
  // must never repaint the list the current remote is showing.
  const listToken = useRef(0);
  const terms = mergeRequestTerms(provider ?? undefined);
  const scope = { rootId, remote: remote ?? "", ...(provider ? { provider } : {}) };

  const finish = (snapshot: RemotePrSnapshot) => {
    useAgentSessionStore
      .getState()
      .ingestConversationMessages(sessionId, snapshot.messages);
    onTaskReady();
  };

  const loadList = useCallback(
    async (nextPage = 1) => {
      if (!remote) return;
      const token = listToken.current;
      const result = await remotePrApi.list(
        sessionId,
        { rootId, remote, ...(provider ? { provider } : {}) },
        nextPage,
      );
      if (token !== listToken.current) return;
      setItems(result.items);
      setLoaded(true);
      setPage(nextPage);
      setHasMore(result.hasMore);
    },
    [sessionId, rootId, remote, provider],
  );

  const fail = (e: unknown) => {
    setError(e instanceof Error ? e.message : String(e));
    setItems([]);
    setLoaded(true);
    setPage(1);
    setHasMore(false);
  };

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
        listToken.current += 1;
        setRemote(first?.name ?? null);
        setProvider(first?.provider ?? null);
        onProvider?.(first?.provider ?? null);
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
    // Discovery is per repository root; provider changes are reported upstream.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, rootId]);

  useEffect(() => {
    if (!remote) return;
    const token = listToken.current;
    void loadList(1).catch((e) => {
      if (token === listToken.current) fail(e);
    });
  }, [remote, loadList]);

  /** One scope change owns the list: drop in-flight answers and start at page 1. */
  const selectRemote = (name: string) => {
    const next = data?.remotes.find((item) => item.name === name);
    listToken.current += 1;
    setRemote(name);
    setProvider(next?.provider ?? null);
    onProvider?.(next?.provider ?? null);
    setItems([]);
    setLoaded(false);
    setPage(1);
    setHasMore(false);
    setPushConfirm(false);
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

  const open = (number: number) =>
    perform(async () =>
      finish(
        await remotePrApi.attach(sessionId, {
          ...scope,
          requestId: crypto.randomUUID(),
          number,
        }),
      ),
    );

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
        <p role="status">正在读取远程仓库…</p>
      ) : !data.remotes.length ? (
        <p>尚未配置远程仓库。为本地仓库添加 GitLab 或 GitHub remote 后即可使用合并请求。</p>
      ) : (
        <>
          <div className="git-actions-repo-line">
            <GitBranch size={14} />
            <code>{data.branch || "Detached HEAD"}</code>
            <span>{data.dirty ? "工作区有改动" : "工作区干净"}</span>
            <Button
              iconOnly
              size="xs"
              variant="ghost"
              aria-label="刷新合并请求"
              disabled={busy}
              onClick={() => void perform(() => loadList(page))}
            >
              <RefreshCw size={13} />
            </Button>
          </div>
          {data.remotes.length > 1 && (
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
                if (name) selectRemote(name);
              }}
            />
          )}
          {!provider && remote && (
            <Select
              label="平台"
              value={provider}
              placeholder="请选择平台"
              disabled={busy}
              onChange={(value) => {
                listToken.current += 1;
                setProvider(value);
                onProvider?.(value);
                setItems([]);
                setLoaded(false);
                setPage(1);
                setHasMore(false);
              }}
              options={[
                { value: "gitlab", label: "GitLab · MR" },
                { value: "github", label: "GitHub · PR" },
              ]}
            />
          )}
          {provider === "gitlab" && (
            <p className="git-actions-description">
              使用 Synax 内置 GitLab 连接与已保存凭据。
              <Link className="text-primary underline" to="/settings?section=gitLab">
                GitLab 登录
              </Link>
            </p>
          )}
          <div className="mr-list" aria-label={`开放中的${terms.request}`}>
            {!remote ? (
              <p className="mr-list__empty">
                {data.remotes[0]?.unsupportedReason ?? "没有可用于合并请求的远程仓库。"}
              </p>
            ) : !loaded ? (
              <p className="git-actions-loading" role="status">
                <LoaderCircle size={14} className="git-actions-spin" />
                正在读取{terms.request}…
              </p>
            ) : !items.length ? (
              <p className="mr-list__empty">
                没有开放的 {terms.short}。
              </p>
            ) : (
              items.map((pr) => {
                const pipeline = pr.checks[0];
                return (
                  <button
                    key={pr.number}
                    type="button"
                    className="mr-list__row"
                    disabled={busy}
                    onClick={() => void open(pr.number)}
                  >
                    <span
                      className={`mr-list__signal mr-list__signal--${pipeline?.status ?? "unknown"}`}
                      title={
                        pipeline
                          ? `流水线 ${pipeline.status === "passed" ? "通过" : pipeline.status === "failed" ? "失败" : "运行中"}`
                          : "无流水线"
                      }
                    />
                    <span className="mr-list__copy">
                      <strong>
                        {mergeRequestRef(terms, pr.number)} {pr.title}
                      </strong>
                      <small>
                        {pr.head} → {pr.base}
                        {pr.draft ? " · 草稿" : ""}
                        {pr.mergeable === false ? " · 冲突" : ""}
                        {pr.author ? ` · @${pr.author}` : ""}
                        {pr.notesCount ? ` · ${pr.notesCount} 条讨论` : ""}
                      </small>
                    </span>
                    <ChevronRight size={15} aria-hidden />
                  </button>
                );
              })
            )}
          </div>
          {(page > 1 || hasMore) && (
            <div className="git-actions-toolbar">
              <Button
                size="xs"
                disabled={busy || page === 1}
                onClick={() => void perform(() => loadList(page - 1))}
              >
                上一页
              </Button>
              <span>第 {page} 页</span>
              <Button
                size="xs"
                disabled={busy || !hasMore}
                onClick={() => void perform(() => loadList(page + 1))}
              >
                下一页
              </Button>
            </div>
          )}
          <details className="git-actions-details">
            <summary>按编号打开 {terms.short}</summary>
            <div className="git-actions-toolbar">
              <Input
                type="number"
                min={1}
                aria-label={`${terms.short} 编号`}
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
                onClick={() => void open(Number(number))}
              >
                打开
              </Button>
            </div>
          </details>
          <details className="git-actions-details">
            <summary>创建 {terms.short}</summary>
            <div className="git-actions-fields">
              <div className="git-actions-two-columns">
                <Field>
                  <Label>来源分支</Label>
                  <Input
                    value={head}
                    onChange={(e) => setHead(e.target.value)}
                    disabled={busy}
                  />
                </Field>
                <Field>
                  <Label>目标分支</Label>
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
                <Label>描述</Label>
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
                <GitMerge size={14} />
                在 {terms.platform} 创建{draft ? "草稿" : ""} {terms.short}
              </Button>
            </div>
          </details>
          <details className="git-actions-details">
            <summary>推送当前本地分支</summary>
            <p className="git-actions-description">
              <code>{data.branch || "Detached HEAD"}</code>
              <ArrowRight size={11} aria-hidden /> <code>{remote}</code>
            </p>
            {data.dirty && <p className="git-actions-error">请先提交工作区改动。</p>}
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
                busy || !remote || !data.branch || data.dirty || !pushConfirm
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
                  setNotice("分支已推送。");
                })
              }
            >
              <Upload size={13} />
              推送 {data.branch}
            </Button>
          </details>
        </>
      )}
    </div>
  );
}
