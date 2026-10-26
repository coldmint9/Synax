import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowRight,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  CircleAlert,
  Code2,
  FileDiff,
  GitBranch,
  GitMerge,
  LoaderCircle,
  Maximize2,
  Pause,
  Play,
  X,
} from "lucide-react";
import type {
  MergeFile,
  MergeFileSave,
} from "../../../adapters/transport/gitMr";
import {
  conversationGitApi,
  type ConversationGitReference,
  type ConversationGitSnapshot,
} from "../../../adapters/transport/conversationGit";
import type { ConversationGitStateEvent } from "../../../../../services/local-node/modules/agent-runtime/conversation-git/contracts";
import { addSessionLiveListener } from "../../../adapters/transport/sessionLiveClient";
import { useTranscriptSession } from "../SessionTranscriptContext";
import { useAgentSessionStore } from "../state/agentSessionStore";
import { refreshWorkspace } from "../workspaceRefresh";
import { Button } from "../../../shared/ui/ui/Button";
import { Dialog, DialogPanel, DialogTitle } from "../../../shared/ui/ui/Dialog";
import { FileViewerDialog } from "../../../shared/ui/file-viewer/FileViewerDialog";
import { taskPresentation } from "./model";
import { applyMergeState, chooseMergeSnapshot } from "./mergeTaskProjection";
import { MergeFileIndex } from "./mergeFileIndex";
import { CommitGraph } from "./CommitGraph";
import { ExpiredMergeTask } from './ExpiredMergeTask';
import { VirtualList } from "./VirtualList";
import { VirtualCheckResults } from "./VirtualCheckResults";
import "./conversationGit.css";

interface ConversationGitCardProps {
  reference: ConversationGitReference;
  messageId?: string;
  readOnly?: boolean;
}
const stopped = new Set([
  "paused",
  "waiting_user",
  "failed",
  "recovery_required",
]);
const terminal = new Set(["merged", "noop", "cancelled"]);
const executionLabels: Record<string, string> = {
  queued: "等待合并助手",
  running: "智能合并中",
  pausing: "正在停止",
  paused: "已停止",
  waiting_user: "等待你的说明",
  cancelling: "正在取消",
  cancelled: "已取消",
  cancelled_cleanup_pending: "已取消 · 待清理",
  completed: "已完成",
  failed: "合并未完成",
  recovery_required: "等待恢复",
};
const phaseLabels: Record<string, string> = {
  preparing: "分析分支",
  resolving: "解决冲突",
  checking: "验证候选",
  applying: "更新目标",
  settled: "合并结束",
};

export function ConversationGitCard(props: ConversationGitCardProps) {
  const scope = useTranscriptSession();
  return (
    <ConversationGitCardInstance
      key={`${scope.sessionId}:${props.reference.sessionId}:${props.reference.objectId}`}
      {...props}
    />
  );
}

function ConversationGitCardInstance({
  reference,
  messageId,
  readOnly = false,
}: ConversationGitCardProps) {
  const scope = useTranscriptSession();
  const owner = scope.sessionId === reference.sessionId;
  const ingest = useAgentSessionStore(
    (state) => state.ingestConversationMessages,
  );
  const [snapshot, setSnapshot] = useState<ConversationGitSnapshot | null>(
    null,
  );
  const snapshotRef = useRef(snapshot);
  const [error, setError] = useState("");
  const [readError, setReadError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState("");
  const [file, setFile] = useState<MergeFile | null>(null);
  const fileRef = useRef(file);
  const [focused, setFocused] = useState(false);
  const [collapsed, setCollapsed] = useState(false);
  const [cancelOpen, setCancelOpen] = useState(false);
  const mounted = useRef(true);
  const readController = useRef<AbortController | null>(null);
  const readPromise = useRef<Promise<void> | null>(null);
  const needsSnapshot = useRef(false);
  const latestEvent = useRef<ConversationGitStateEvent | null>(null);
  const fileController = useRef<AbortController | null>(null);
  const mutation = useRef(false);
  const draftFlush = useRef<(() => Promise<boolean>) | null>(null);
  const eventFrame = useRef(0);
  const stateEventPending = useRef<ConversationGitStateEvent | null>(null);
  const fileIndex = useRef(new MergeFileIndex());
  const hasFileManifest = useRef(false);
  const fullManifestRevision = useRef(-1);
  const pendingFileChanges = useRef(
    new Map<
      string,
      { file: ConversationGitSnapshot["files"][number]; revision: number }
    >(),
  );
  const fileRefreshTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const fileRefreshBusy = useRef(false);
  const fileRefreshPending = useRef(false);

  const restoreManifest = useCallback((response: ConversationGitSnapshot) => {
    if (
      !hasFileManifest.current ||
      response.task.revision >= fullManifestRevision.current
    ) {
      fileIndex.current = new MergeFileIndex();
      fileIndex.current.replace(response.files, response.task.revision);
      fullManifestRevision.current = response.task.revision;
      hasFileManifest.current = true;
    }
    const newer: ConversationGitSnapshot["files"] = [];
    let revision = fullManifestRevision.current;
    for (const [id, change] of pendingFileChanges.current) {
      if (change.revision <= fullManifestRevision.current)
        pendingFileChanges.current.delete(id);
      else {
        newer.push(change.file);
        revision = Math.max(revision, change.revision);
      }
    }
    if (newer.length) fileIndex.current.update(newer, revision);
  }, []);

  const publish = useCallback((next: ConversationGitSnapshot) => {
    if (!mounted.current) return;
    snapshotRef.current = next;
    setSnapshot(next);
  }, []);
  const setSelectedFile = useCallback((next: MergeFile | null) => {
    fileRef.current = next;
    if (mounted.current) setFile(next);
  }, []);

  const load = useCallback(async () => {
    if (!owner || !mounted.current) {
      setLoading(false);
      return;
    }
    needsSnapshot.current = true;
    if (readPromise.current) return readPromise.current;
    const operation = (async () => {
      do {
        needsSnapshot.current = false;
        const controller = new AbortController();
        readController.current = controller;
        try {
          const response = await conversationGitApi.get(
            reference.sessionId,
            reference.objectId,
            controller.signal,
          );
          if (!mounted.current || controller.signal.aborted) return;
          if (
            response.task.id !== reference.objectId ||
            response.task.sessionId !== reference.sessionId ||
            response.task.projectId !== reference.projectId
          )
            throw new Error("任务响应与当前会话不匹配。");
          const next = latestEvent.current
            ? applyMergeState(response, latestEvent.current)
            : response;
          if (messageId && response.task.messageId !== messageId) ingest(reference.sessionId, response.messages);
          restoreManifest(response);
          publish(chooseMergeSnapshot(snapshotRef.current, next));
          setReadError("");
        } catch (cause) {
          if (mounted.current && !controller.signal.aborted)
            setReadError(
              cause instanceof Error ? cause.message : String(cause),
            );
        } finally {
          if (readController.current === controller)
            readController.current = null;
          if (mounted.current) setLoading(false);
        }
      } while (mounted.current && needsSnapshot.current);
    })();
    readPromise.current = operation;
    try {
      await operation;
    } finally {
      if (readPromise.current === operation) readPromise.current = null;
    }
  }, [
    owner,
    messageId,
    ingest,
    publish,
    restoreManifest,
    reference.objectId,
    reference.projectId,
    reference.sessionId,
  ]);

  const readFile = useCallback(
    async (id: string, background = false) => {
      if (!mounted.current || !owner) return;
      fileController.current?.abort();
      const controller = new AbortController();
      fileController.current = controller;
      if (!background) setBusy(`file:${id}`);
      try {
        const next = await conversationGitApi.file(
          reference.sessionId,
          reference.objectId,
          id,
          controller.signal,
        );
        if (
          mounted.current &&
          !controller.signal.aborted &&
          (!background || fileRef.current?.id === id)
        )
          setSelectedFile(next);
        return next;
      } catch (cause) {
        if (mounted.current && !controller.signal.aborted)
          setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        if (fileController.current === controller)
          fileController.current = null;
        if (mounted.current && !background)
          setBusy((current) => (current === `file:${id}` ? "" : current));
      }
    },
    [owner, reference.objectId, reference.sessionId, setSelectedFile],
  );

  const invalidateOpenFile = useCallback(() => {
    fileRefreshPending.current = true;
    const refresh = async () => {
      fileRefreshTimer.current = null;
      if (!mounted.current || !fileRef.current) {
        fileRefreshPending.current = false;
        return;
      }
      if (fileRefreshBusy.current) return;
      fileRefreshBusy.current = true;
      fileRefreshPending.current = false;
      try {
        await readFile(fileRef.current.id, true);
      } finally {
        fileRefreshBusy.current = false;
        if (fileRefreshPending.current && mounted.current)
          fileRefreshTimer.current = setTimeout(() => void refresh(), 250);
      }
    };
    if (!fileRefreshTimer.current && !fileRefreshBusy.current)
      fileRefreshTimer.current = setTimeout(() => void refresh(), 250);
  }, [readFile]);

  useEffect(() => {
    mounted.current = true;
    const release = owner
      ? addSessionLiveListener(reference.sessionId, (event) => {
          if (event.type === "domain_reconnected") {
            void load();
            return;
          }
          if (
            event.type !== "conversation_git_state" ||
            event.taskId !== reference.objectId
          )
            return;
          const previous = latestEvent.current;
          const authoritative = snapshotRef.current;
          if (
            authoritative &&
            (event.taskRevision < authoritative.task.revision ||
              (event.taskRevision === authoritative.task.revision &&
                event.mrVersion < authoritative.mr.version))
          )
            return;
          if (
            authoritative &&
            event.taskRevision > authoritative.task.revision &&
            event.mrVersion < authoritative.mr.version
          ) {
            // A replan creates a new MR whose local version starts again.
            // A small event cannot identify that binding; obtain its snapshot.
            void load();
            return;
          }
          if (
            previous &&
            (event.taskRevision < previous.taskRevision ||
              (event.taskRevision === previous.taskRevision &&
                event.eventSeq <= previous.eventSeq))
          )
            return;
          const mergedEvent = event;
          latestEvent.current = mergedEvent;
          if (event.files) {
            fileIndex.current.replace(event.files, event.taskRevision);
            hasFileManifest.current = true;
            fullManifestRevision.current = event.taskRevision;
            for (const [id, change] of pendingFileChanges.current)
              if (change.revision <= event.taskRevision)
                pendingFileChanges.current.delete(id);
          }
          if (event.changedFiles)
            fileIndex.current.update(event.changedFiles, event.taskRevision);
          if (event.changedFiles)
            for (const changed of event.changedFiles)
              pendingFileChanges.current.set(changed.id, {
                file: changed,
                revision: event.taskRevision,
              });
          stateEventPending.current = mergedEvent;
          const flushEvent = () => {
            const pending = stateEventPending.current;
            stateEventPending.current = null;
            if (pending && snapshotRef.current)
              publish(applyMergeState(snapshotRef.current, pending));
          };
          if (
            terminal.has(event.status) ||
            [
              "paused",
              "waiting_user",
              "failed",
              "recovery_required",
              "cancelling",
            ].includes(event.execution?.status ?? "")
          ) {
            cancelAnimationFrame(eventFrame.current);
            eventFrame.current = 0;
            flushEvent();
          } else if (!eventFrame.current) {
            eventFrame.current = requestAnimationFrame(() => {
              eventFrame.current = 0;
              if (mounted.current) flushEvent();
            });
          }
          // One authoritative receipt load at a terminal transition, never per progress event.
          if (terminal.has(event.status) && previous?.status !== event.status)
            void load();
          // File bodies are loaded only for an open file and only after an actual file-list invalidation.
          if (
            fileRef.current &&
            (event.files || event.changedFileIds?.includes(fileRef.current.id))
          )
            invalidateOpenFile();
        })
      : () => {};
    void load();
    return () => {
      mounted.current = false;
      release();
      readController.current?.abort();
      fileController.current?.abort();
      cancelAnimationFrame(eventFrame.current);
      stateEventPending.current = null;
      if (fileRefreshTimer.current) clearTimeout(fileRefreshTimer.current);
      fileRefreshTimer.current = null;
      fileRefreshPending.current = false;
    };
  }, [
    invalidateOpenFile,
    load,
    owner,
    publish,
    restoreManifest,
    reference.objectId,
    reference.sessionId,
  ]);

  const action = async (name: "pause" | "resume" | "cancel") => {
    if (readOnly || !owner || mutation.current || !snapshotRef.current) return;
    mutation.current = true;
    setBusy(name === "resume" && draftFlush.current ? "saving" : name);
    setCancelOpen(false);
    setError("");
    try {
      if (
        name === "resume" &&
        draftFlush.current &&
        !(await draftFlush.current())
      )
        return;
      setBusy(name);
      const current = snapshotRef.current;
      if (!current) return;
      const next = await conversationGitApi.action(
        reference.sessionId,
        reference.objectId,
        {
          action: name,
          requestId: crypto.randomUUID(),
          expectedVersion: current.mr.version,
          expectedTaskRevision: current.task.revision,
        },
      );
      ingest(reference.sessionId, next.messages);
      refreshWorkspace(reference.sessionId, reference.rootId);
      if (!mounted.current) return;
      restoreManifest(next);
      publish(chooseMergeSnapshot(snapshotRef.current, next));
      if (next.task.mrId !== current.task.mrId || terminal.has(next.mr.status))
        setSelectedFile(null);
    } catch (cause) {
      if (mounted.current) {
        setError(cause instanceof Error ? cause.message : String(cause));
        void load();
      }
    } finally {
      mutation.current = false;
      if (mounted.current) setBusy("");
    }
  };
  const saveFile = async (input: MergeFileSave) => {
    const current = snapshotRef.current,
      selected = fileRef.current;
    if (
      !current ||
      !selected ||
      readOnly ||
      !owner ||
      current.stale ||
      (current.execution && !stopped.has(current.execution.status))
    )
      throw new Error("请先停止智能合并后再编辑结果。");
    const next = await conversationGitApi.saveFile(
      reference.sessionId,
      reference.objectId,
      selected.id,
      {
        ...input,
        resolve: false,
        expectedVersion: current.mr.version,
        expectedTaskRevision: current.task.revision,
        requestId: crypto.randomUUID(),
      },
    );
    ingest(reference.sessionId, next.messages);
    refreshWorkspace(reference.sessionId, reference.rootId);
    if (mounted.current) {
      restoreManifest(next);
      publish(chooseMergeSnapshot(snapshotRef.current, next));
    }
    const updated = await readFile(selected.id, true);
    if (!updated)
      throw new Error(
        "草稿已写入，但最新文件版本暂不可读。请保留当前编辑并重试。",
      );
    return { revision: updated.revision };
  };

  const presentation = useMemo(
    () => (snapshot ? taskPresentation({ ...snapshot, files: [] }) : null),
    [snapshot?.mr, snapshot?.stale],
  );
  if (!owner)
    return (
      <section className="conversation-git-card" aria-label="Git合并任务">
        <CircleAlert size={15} />
        <span>此任务属于另一个会话，请返回任务所属会话。</span>
      </section>
    );
  if (!snapshot)
    return (
      <section
        className="conversation-git-card"
        role={error || readError ? "alert" : "status"}
      >
        {loading ? (
          <>
            <LoaderCircle className="conversation-git-spin" size={15} />
            正在加载合并任务…
          </>
        ) : (
          <>
            {error || readError || "合并任务不可用。"}
            <Button onClick={() => void load()}>继续</Button>
          </>
        )}
      </section>
    );
  const { mr, execution } = snapshot;
  if (messageId && snapshot.task.messageId !== messageId) return <ExpiredMergeTask title={reference.title} />;
  if (!presentation) return null;
  const cleanupPending = execution?.status === "cancelled_cleanup_pending";
  const finished =
    !cleanupPending &&
    (terminal.has(mr.status) ||
      execution?.status === "cancelled" ||
      execution?.status === "completed");
  const canResume =
    !execution || stopped.has(execution.status) || cleanupPending;
  const moving =
    !!execution &&
    ["queued", "running", "pausing", "cancelling"].includes(execution.status);
  const status = execution
    ? executionLabels[execution.status]
    : presentation.status;
  const applying = execution?.phase === "applying" || mr.status === "applying";
  const readonlyFile =
    readOnly ||
    snapshot.stale ||
    (!!execution && !stopped.has(execution.status)) ||
    !file?.conflicted ||
    ["resume", "pause", "cancel"].includes(busy);
  const controls =
    !readOnly && !finished ? (
      <div
        className="conversation-git-control"
        role="group"
        aria-label="智能合并控制"
      >
        <Button
          size="sm"
          variant="primary"
          disabled={
            (!!busy && !busy.startsWith("file:")) ||
            ["pausing", "cancelling"].includes(execution?.status ?? "") ||
            applying
          }
          onClick={() => void action(canResume ? "resume" : "pause")}
        >
          {canResume ? <Play size={13} /> : <Pause size={13} />}
          {cleanupPending
            ? "重试清理"
            : execution?.status === "pausing"
              ? "正在停止"
              : execution?.status === "cancelling"
                ? "正在取消"
                : canResume
                  ? "继续"
                  : "停止"}
        </Button>
        {!cleanupPending && (
          <Button
            size="sm"
            variant="danger-soft"
            disabled={
              applying || execution?.status === "cancelling" || mutation.current
            }
            onClick={() => setCancelOpen(true)}
          >
            <X size={13} />
            取消
          </Button>
        )}
      </div>
    ) : null;
  const content = (
    <section
      className="conversation-git-card conversation-git-card--window"
      aria-label={`Git合并任务：${reference.title}`}
      data-object-id={reference.objectId}
    >
      <header className="conversation-git-card__header">
        <div className="conversation-git-card__title">
          <span className="conversation-git-card__icon">
            <GitBranch size={18} />
          </span>
          <div>
            <h3>{reference.title}</h3>
            <p>
              <code>{mr.steps.map((step) => step.branch).join(" + ")}</code>
              <ArrowRight size={12} />
              <code>{mr.target}</code>
            </p>
          </div>
        </div>
        <div className="conversation-git-card__header-actions">
          <span
            className="conversation-git-status"
            role="status"
            aria-live="polite"
          >
            {moving && (
              <LoaderCircle className="conversation-git-spin" size={13} />
            )}
            {status}
          </span>
          <button
            className="conversation-git-icon-button"
            aria-label={focused ? "退出专注视图" : "展开专注视图"}
            onClick={() => setFocused((value) => !value)}
          >
            <Maximize2 size={14} />
          </button>
          <button
            className="conversation-git-icon-button"
            aria-label={collapsed ? "展开合并任务" : "折叠合并任务"}
            onClick={() => setCollapsed((value) => !value)}
          >
            {collapsed ? <ChevronRight size={15} /> : <ChevronDown size={15} />}
          </button>
        </div>
      </header>
      {!collapsed && (
        <>
          <div
            className="conversation-git-body"
            role="region"
            aria-label="合并任务内容"
            tabIndex={0}
          >
            <div className="conversation-git-progress">
              <strong>
                {execution ? phaseLabels[execution.phase] : status}
              </strong>
              <span>
                {fileIndex.current.ids.length - fileIndex.current.conflicts}/
                {fileIndex.current.ids.length} 个文件已处理
              </span>
              <p>
                {execution?.summary ||
                  (moving
                    ? "合并助手正在检查并处理候选变更。"
                    : "点击文件查看合并结果。")}
              </p>
            </div>
            {!finished && (
              <CommitGraph
                commits={snapshot.commits}
                pendingMerge={
                  !cleanupPending && !snapshot.stale
                    ? {
                        key: mr.id,
                        target: mr.target,
                        sources: mr.steps.map((step) => step.branch),
                        parents: [
                          mr.targetOid,
                          ...mr.steps.map((step) => step.oid),
                        ],
                        candidateOid: mr.candidateOid,
                      }
                    : undefined
                }
                animate={!readOnly && execution?.status === "running"}
              />
            )}
            {fileIndex.current.ids.length > 0 && (
              <section className="conversation-git-files">
                <div className="conversation-git-section-heading">
                  <div>
                    <FileDiff size={14} />
                    <strong>合并文件</strong>
                    <span>{fileIndex.current.conflicts} 个冲突</span>
                  </div>
                  <span>点击打开编辑器</span>
                </div>
                <VirtualList
                  items={fileIndex.current.ids}
                  getKey={(id) => id}
                  label="合并文件列表"
                  rowHeight={38}
                  maxHeight={266}
                  renderRow={(id) => {
                    const item = fileIndex.current.byId.get(id)!;
                    return (
                      <button
                        className="conversation-git-file-row"
                        onClick={() => void readFile(item.id)}
                        aria-haspopup="dialog"
                        title={item.path}
                      >
                        <Code2 size={14} />
                        <span>{item.path}</span>
                        <span
                          className={
                            item.conflicted ? "is-conflicted" : "is-resolved"
                          }
                        >
                          {item.conflicted ? "冲突" : "已解决"}
                        </span>
                        {busy === `file:${item.id}` ? (
                          <LoaderCircle
                            className="conversation-git-spin"
                            size={13}
                          />
                        ) : (
                          <ChevronRight size={13} />
                        )}
                      </button>
                    );
                  }}
                />
              </section>
            )}
            {snapshot.stale && (
              <p className="conversation-git-inline-error" role="alert">
                {snapshot.staleReason || "分支基线已更新，继续时将重新核验。"}
              </p>
            )}
            {(execution?.error || mr.error || error || readError) && (
              <p className="conversation-git-inline-error" role="alert">
                {error || execution?.error || mr.error || readError}
              </p>
            )}
            {mr.checks.length > 0 && (
              <details className="conversation-git-checks">
                <summary>
                  <CheckCircle2 size={14} />
                  验证检查 · {presentation.passed}/{mr.checks.length}
                </summary>
                <VirtualCheckResults results={presentation.results} />
              </details>
            )}
            {presentation.complete && (
              <div className="conversation-git-receipt">
                <GitMerge size={18} />
                <div>
                  <strong>
                    {mr.status === "noop"
                      ? "分支已包含这些变更"
                      : `已合并到 ${mr.target}`}
                  </strong>
                  <span>
                    候选提交{" "}
                    <code>
                      {mr.candidateOid?.slice(0, 12) ??
                        mr.targetOid.slice(0, 12)}
                    </code>{" "}
                    · 结果已保存
                  </span>
                </div>
              </div>
            )}
            {finished && snapshot.commits.length > 0 && (
              <details className="conversation-git-history">
                <summary>提交关系</summary>
                <CommitGraph commits={snapshot.commits} animate={false} />
              </details>
            )}
          </div>
          <footer className="conversation-git-footer">
            <span>
              {applying
                ? "正在更新目标，完成后将显示真实结果"
                : finished
                  ? status
                  : execution?.joinMode === "async"
                    ? "合并助手在后台运行"
                    : "主会话正在等待合并助手"}
            </span>
            {!file && controls}
          </footer>
        </>
      )}
    </section>
  );
  return (
    <>
      {focused ? (
        <button
          className="conversation-git-focus-return"
          onClick={() => setFocused(false)}
        >
          <GitMerge size={14} />
          合并任务正在专注视图中显示
        </button>
      ) : (
        content
      )}
      {focused && (
        <Dialog open onClose={() => setFocused(false)}>
          <DialogPanel className="conversation-git-dialog">
            <div className="conversation-git-focus-header">
              <DialogTitle>{reference.title}</DialogTitle>
              <Button
                iconOnly
                aria-label="关闭专注视图"
                onClick={() => setFocused(false)}
              >
                <X size={15} />
              </Button>
            </div>
            {content}
          </DialogPanel>
        </Dialog>
      )}
      {file && (
        <FileViewerDialog
          file={file}
          managed
          readOnly={readonlyFile}
          onClose={() => {
            fileController.current?.abort();
            setSelectedFile(null);
          }}
          onSave={saveFile}
          readSlice={(side, byteOffset, maxBytes, expectedRevision, signal) =>
            conversationGitApi.fileSlice(
              reference.sessionId,
              reference.objectId,
              file.id,
              { side, byteOffset, maxBytes, expectedRevision },
              signal,
            )
          }
          controls={controls}
          registerDraftFlush={(flush) => {
            draftFlush.current = flush;
          }}
        />
      )}
      {cancelOpen && (
        <Dialog open onClose={() => setCancelOpen(false)}>
          <DialogPanel className="conversation-git-confirm">
            <DialogTitle>取消此次合并？</DialogTitle>
            <p>取消会停止合并助手并放弃候选合并，目标分支不会被回退。</p>
            <div>
              <Button onClick={() => setCancelOpen(false)}>继续合并</Button>
              <Button
                variant="danger"
                disabled={mutation.current}
                onClick={() => void action("cancel")}
              >
                确认取消
              </Button>
            </div>
          </DialogPanel>
        </Dialog>
      )}
    </>
  );
}
export default ConversationGitCard;
