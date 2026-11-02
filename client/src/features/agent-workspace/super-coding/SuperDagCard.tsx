import { useEffect, useId, useState, type ReactNode } from "react";
import { ChevronDown, ChevronRight, Workflow } from "lucide-react";
import type {
  SuperGraph,
  SuperNode,
} from "../../../../../packages/contracts/super-coding";
import { DialogOverlay } from "../../../shared/ui/DialogOverlay";
import { useDialogFocus } from "../../../shared/ui/directory-picker/useDialogFocus";
import { SuperDagGraph } from "./SuperDagGraph";
import {
  NODE_STATUS_LABEL,
  PHASE_LABEL,
  budgetText,
  graphCounts,
} from "./superGraphModel";
import { useSuperGraph } from "./useSuperGraph";

type DetailTab = "conversation" | "delivery" | "routing";

interface Props {
  sessionId: string | null;
  defaultOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  onOpenChildSession?: (childSessionId: string) => void;
}

const TAB_LABEL: Record<DetailTab, string> = {
  conversation: "对话",
  delivery: "交付",
  routing: "路由",
};

export function SuperDagCard({
  sessionId,
  defaultOpen = false,
  onOpenChange,
  onOpenChildSession,
}: Props) {
  const [open, setOpen] = useState(defaultOpen);
  const [expanded, setExpanded] = useState(false);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [tab, setTab] = useState<DetailTab>("conversation");
  const [draft, setDraft] = useState("");
  const [notice, setNotice] = useState<string | null>(null);
  const bodyId = useId();
  const { graph, loading, error, channel, loadChannel, sendCommand } =
    useSuperGraph(sessionId);
  const counts = graphCounts(graph);
  const selected = graph?.nodes.find((node) => node.id === selectedId) ?? null;
  // A failed or archived node has no live child, so the runtime refuses its
  // messages; keep the composer inert instead of collecting a draft that cannot
  // be delivered.
  const messageLocked =
    selected?.status === "failed" || selected?.status === "archived";

  useEffect(() => {
    void loadChannel(selectedId);
  }, [loadChannel, selectedId]);

  const toggle = () => {
    const next = !open;
    setOpen(next);
    onOpenChange?.(next);
  };

  const run = async (action: () => Promise<{ ok: boolean; message?: string; code?: string }>) => {
    setNotice(null);
    const result = await action();
    if (!result.ok) setNotice(result.message ?? result.code ?? "操作未完成");
  };

  // No graph means the main agent has not planned anything yet: an empty
  // shell above the composer is noise, so render nothing at all.
  if (!graph) return null;

  // The session composer root is pointer-events:none (only its inner shell
  // re-enables clicks), so an entry rendered beside that shell has to opt in —
  // otherwise it looks clickable but every click falls through the page.
  if (!open)
    return (
      <button
        type="button"
        onClick={toggle}
        aria-expanded={false}
        aria-controls={bodyId}
        className="super-dag-trigger pointer-events-auto inline-flex min-h-8 min-w-0 max-w-full items-center gap-1.5 rounded-[7px] border border-transparent px-2 py-1 text-left text-xs text-muted-foreground hover:border-border hover:bg-muted hover:text-foreground focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
      >
        <Workflow size={14} className="shrink-0" aria-hidden="true" />
        <span className="min-w-0 break-words">编排 · {counts.live} 节点 · {PHASE_LABEL[graph.phase]}</span>
        <ChevronRight size={13} className="shrink-0" aria-hidden="true" />
      </button>
    );

  // One body instance feeds both surfaces: the inline card and the inspection
  // modal, so selection, tabs and the channel draft never diverge.
  const body = (
    <>
      {loading && <p className="px-3 py-4 text-xs text-muted-foreground">正在读取编排…</p>}
      {error && <p role="alert" className="px-3 py-2 text-xs text-destructive">{error}</p>}


      {graph && (
        <>
          {selected ? (
            <div className="flex min-h-0 flex-1 flex-col">
              <div className="flex items-center gap-2 border-b border-border px-3 py-1.5">
                <button
                  type="button"
                  onClick={() => setSelectedId(null)}
                  className="text-[11px] text-muted-foreground"
                >
                  ← 返回
                </button>
                <span className="truncate text-xs font-semibold">{selected.title}</span>
                <span className="ml-auto text-[11px] text-muted-foreground">
                  {NODE_STATUS_LABEL[selected.status]}
                </span>
              </div>
              <div role="tablist" aria-label="节点详情" className="flex gap-1 border-b border-border px-2">
                {(Object.keys(TAB_LABEL) as DetailTab[]).map((key) => (
                  <button
                    key={key}
                    role="tab"
                    type="button"
                    aria-selected={tab === key}
                    onClick={() => setTab(key)}
                    className={`border-b-2 px-2 py-1.5 text-[11px] ${tab === key ? "border-emerald-600 font-semibold" : "border-transparent text-muted-foreground"}`}
                  >
                    {TAB_LABEL[key]}
                  </button>
                ))}
              </div>
              <div className="min-h-0 flex-1 overflow-auto px-3 py-2 text-xs">
                {tab === "conversation" && (
                  <div className="grid gap-2">
                    <p className="text-muted-foreground">
                      已投递 {selected.messages} 条消息（每节点上限 6 条，下一轮次生效）。
                    </p>
                    {channel.length > 0 ? (
                      <ol aria-label="通道消息" className="grid list-none gap-1.5 p-0">
                        {channel.map((item, index) => (
                          <li
                            key={`${item.at}-${index}`}
                            className="rounded-md bg-muted/60 px-2 py-1.5"
                          >
                            <span className="block text-[10px] text-muted-foreground">
                              {item.from} · {item.delivery === "queued" ? "已排队" : "已投递"}
                            </span>
                            <span className="block text-[11.5px]">{item.text}</span>
                          </li>
                        ))}
                      </ol>
                    ) : (
                      <p className="text-muted-foreground">这个节点还没有收到消息。</p>
                    )}
                    {selected.childSessionId && onOpenChildSession && (
                      <button
                        type="button"
                        onClick={() => onOpenChildSession(selected.childSessionId!)}
                        className="justify-self-start rounded-md border border-border px-2 py-1 text-[11px]"
                      >
                        打开子会话
                      </button>
                    )}
                    <div className="flex gap-1.5">
                      <input
                        value={draft}
                        onChange={(event) => setDraft(event.target.value)}
                        disabled={messageLocked}
                        aria-label="给节点发消息"
                        placeholder="补充一条指令…"
                        className="min-w-0 flex-1 rounded-md border border-border px-2 py-1 text-[11px]"
                      />
                      <button
                        type="button"
                        disabled={messageLocked || !draft.trim()}
                        onClick={() => {
                          const text = draft.trim();
                          if (!text) return;
                          setDraft("");
                          void run(async () => {
                            const result = await sendCommand({
                              kind: "node.message",
                              nodeId: selected.id,
                              text,
                            });
                            if (result.ok) await loadChannel(selected.id);
                            return result;
                          });
                        }}
                        className="rounded-md border border-border px-2 py-1 text-[11px] disabled:opacity-40"
                      >
                        发送
                      </button>
                    </div>
                  </div>
                )}
                {tab === "delivery" && (
                  <dl className="grid grid-cols-[64px_1fr] gap-1.5">
                    <dt className="text-muted-foreground">交付</dt>
                    <dd>{selected.deliverable || "尚未产出"}</dd>
                    <dt className="text-muted-foreground">摘要</dt>
                    <dd>{selected.summary ?? "—"}</dd>
                    <dt className="text-muted-foreground">写域</dt>
                    <dd>{selected.scope.length ? selected.scope.join("、") : "继承"}</dd>
                    <dt className="text-muted-foreground">验收</dt>
                    <dd>
                      {selected.acceptance.length
                        ? selected.acceptance.map((item) => (
                            <span key={item} className="block">
                              {selected.status === "completed" ? "✓ " : "○ "}
                              {item}
                            </span>
                          ))
                        : "—"}
                    </dd>
                  </dl>
                )}
                {tab === "routing" && (
                  <dl className="grid grid-cols-[64px_1fr] gap-1.5">
                    <dt className="text-muted-foreground">模型</dt>
                    <dd>{selected.model || "跟随主会话"}</dd>
                    <dt className="text-muted-foreground">思考档</dt>
                    <dd>{selected.effort}</dd>
                    <dt className="text-muted-foreground">任务类型</dt>
                    <dd>{selected.taskType}</dd>
                    {selected.retries ? (
                      <>
                        <dt className="text-muted-foreground">重试</dt>
                        <dd>{selected.retries}</dd>
                      </>
                    ) : null}
                    <dt className="text-muted-foreground">错误</dt>
                    <dd>{selected.error ?? selected.lastError ?? "—"}</dd>
                  </dl>
                )}
              </div>
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-auto">
              <SuperDagGraph
                graph={graph}
                selectedNodeId={selectedId}
                onSelectNode={(nodeId) => {
                  setSelectedId(nodeId);
                  setTab("conversation");
                }}
              />
            </div>
          )}

          {notice && (
            <p role="status" className="border-t border-border px-3 py-1.5 text-[11px] text-amber-700">
              {notice}
            </p>
          )}
        </>
      )}
    </>
  );

  return (
    <>
      <section
        aria-label="编排图"
        className="super-dag-card pointer-events-auto flex w-full min-w-0 basis-full flex-col overflow-hidden rounded-xl border border-border bg-card"
      >
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-3 py-1.5">
          <button
            type="button"
            onClick={toggle}
            aria-expanded={open}
            aria-controls={bodyId}
            className="super-dag-trigger inline-flex min-h-8 items-center gap-1.5 rounded-[7px] border border-transparent px-2 py-1 text-xs font-medium hover:border-border hover:bg-muted focus-visible:outline focus-visible:outline-2 focus-visible:outline-ring focus-visible:outline-offset-2"
          >
            <ChevronDown size={14} aria-hidden="true" />
            编排
            <span className="text-muted-foreground">{counts.live}</span>
          </button>
          <span className="text-[11px] text-muted-foreground">
            {PHASE_LABEL[graph.phase]}
          </span>
          <span className="flex min-w-0 flex-wrap gap-x-2.5 gap-y-1 text-[11px] text-muted-foreground">
            <span>{budgetText(graph)}</span>
            <span>运行 {counts.running}</span>
            {counts.failed > 0 && <span className="text-destructive">失败 {counts.failed}</span>}
            <span>对话 {counts.messages}</span>
          </span>
          <div className="ml-auto flex items-center gap-1">
            <button
              type="button"
              onClick={() => setExpanded(true)}
              aria-haspopup="dialog"
              aria-expanded={expanded}
              className="rounded-md border border-border bg-card px-1.5 py-1 text-[11px] text-muted-foreground"
            >
              展开
            </button>
          </div>
        </div>

        <div id={bodyId} className="flex max-h-[min(24rem,50dvh)] min-h-0 flex-1 flex-col overflow-auto">
          {body}
        </div>
      </section>

      {expanded && (
        <SuperDagDialog graph={graph} onClose={() => setExpanded(false)}>
          {body}
        </SuperDagDialog>
      )}
    </>
  );
}

/**
 * Modal inspection surface for the graph. It only owns the dialog chrome and
 * focus handling; the graph, node detail and composer come in as children so
 * both surfaces stay in sync.
 */
function SuperDagDialog({
  graph,
  onClose,
  children,
}: {
  graph: SuperGraph;
  onClose: () => void;
  children: ReactNode;
}) {
  const dialogRef = useDialogFocus(onClose);
  const counts = graphCounts(graph);
  return (
    <DialogOverlay
      className="super-dag-dialog-overlay"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-label="编排图检视"
        style={{ width: "min(64rem, 100%)", maxWidth: "100%", padding: 0, maxHeight: "100%" }}
        className="dialog-content flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card"
      >
        <div className="flex flex-wrap items-center gap-2 border-b border-border bg-muted/30 px-3 py-1.5">
          <span className="text-xs font-semibold">编排图</span>
          <span className="text-[11px] text-muted-foreground">
            {PHASE_LABEL[graph.phase]}
          </span>
          <span className="flex min-w-0 flex-wrap gap-x-2.5 gap-y-1 text-[11px] text-muted-foreground">
            <span>{budgetText(graph)}</span>
            <span>运行 {counts.running}</span>
            {counts.failed > 0 && <span className="text-destructive">失败 {counts.failed}</span>}
            <span>对话 {counts.messages}</span>
          </span>
          <button
            type="button"
            onClick={onClose}
            aria-label="关闭编排图检视"
            data-dialog-autofocus
            className="ml-auto rounded-md border border-border bg-card px-2 py-1 text-[11px] text-muted-foreground"
          >
            关闭
          </button>
        </div>
        <div className="min-h-0 flex-1 overflow-auto">{children}</div>
      </div>
    </DialogOverlay>
  );
}
