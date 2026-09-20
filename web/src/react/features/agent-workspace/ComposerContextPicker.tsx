import { useEffect, useRef, useState } from "react";
import { Popover } from "@heroui/react";
import {
  ArrowLeft,
  Minimize2,
  Loader2,
  BookOpen,
  FileText,
  Plus,
  Plug,
  Sparkles,
} from "lucide-react";
import {
  agentRuntimeApi,
  type TurnReference,
  type TurnReferenceOption,
} from "../../../lib/api/agentRuntime";
import { useShellStore } from "../../state/shellStore";
import { useLocale } from "../../../hooks/useLocale";
import { FileTypeIcon } from "./FileTypeIcon";

const contextTypes = [
  { id: "skill", zh: "技能", en: "Skill", Icon: Sparkles },
  { id: "mcp", zh: "MCP 服务", en: "MCP server", Icon: Plug },
  { id: "file", zh: "项目文件", en: "Project file", Icon: FileText },
  { id: "wiki", zh: "Wiki 文档", en: "Wiki document", Icon: BookOpen },
] as const;

export function ComposerContextPicker({
  projectId,
  sessionId,
  backendId,
  references,
  onChange,
  disabled,
  compactDisabled,
  onOpen,
  onOpenChange,
}: {
  projectId: string;
  sessionId?: string;
  backendId: string;
  references: TurnReference[];
  onChange: (references: TurnReference[]) => void;
  disabled: boolean;
  compactDisabled?: boolean;
  onOpen: () => void;
  onOpenChange?: (open: boolean) => void;
}) {
  const wikiEnabled = useShellStore((s) => s.preferences.wikiEnabled);
  const { locale } = useLocale(),
    zh = locale === "zh";
  const [open, setOpen] = useState(false);
  const [kind, setKind] = useState<TurnReference["kind"] | null>(null);
  const [search, setSearch] = useState("");
  const [options, setOptions] = useState<TurnReferenceOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [compacting, setCompacting] = useState(false);
  const [compactMessage, setCompactMessage] = useState("");
  const compactRequest = useRef(0);
  const compactPending = useRef(false);
  useEffect(() => {
    compactRequest.current += 1;
    compactPending.current = false;
    setCompacting(false);
    setCompactMessage("");
    return () => {
      compactRequest.current += 1;
    };
  }, [projectId, sessionId, backendId]);
  const compactUnavailable =
    !sessionId || backendId !== "native" || compactDisabled;
  const compactHint = !sessionId
    ? zh
      ? "发送消息后可用"
      : "Available after starting a session"
    : backendId !== "native"
      ? zh
        ? "此后端自行管理上下文压缩"
        : "This backend manages its own context"
      : compactDisabled
        ? zh
          ? "当前任务结束后可用"
          : "Available when the current run finishes"
        : zh
          ? "立即压缩历史，保留最近上下文"
          : "Compact history now, keeping recent context";
  const handleCompact = async () => {
    if (!sessionId || compactUnavailable || compactPending.current) return;
    compactPending.current = true;
    const request = ++compactRequest.current;
    setCompacting(true);
    setCompactMessage("");
    setError("");
    try {
      const result = await agentRuntimeApi.compactContext(sessionId);
      if (request !== compactRequest.current) return;
      setCompactMessage(
        result.compacted
          ? zh
            ? "上下文已压缩，原始会话记录仍保留"
            : "Context compacted. Original conversation history is preserved."
          : zh
            ? "暂无可安全压缩的历史上下文"
            : "No history can be safely compacted yet.",
      );
    } catch (err) {
      if (request === compactRequest.current)
        setError(err instanceof Error ? err.message : String(err));
    } finally {
      if (request === compactRequest.current) {
        compactPending.current = false;
        setCompacting(false);
      }
    }
  };
  useEffect(() => {
    setOpen(false);
    setKind(null);
    setSearch("");
  }, [projectId, sessionId, backendId, disabled, wikiEnabled]);
  useEffect(() => {
    if (!open || !kind) return;
    let current = true;
    setOptions([]);
    setLoading(true);
    setError("");
    const timer = window.setTimeout(
      () => {
        void agentRuntimeApi
          .listReferenceOptions(projectId, kind, search, sessionId)
          .then((result) => {
            if (current) setOptions(result.items);
          })
          .catch((err) => {
            if (current)
              setError(err instanceof Error ? err.message : String(err));
          })
          .finally(() => {
            if (current) setLoading(false);
          });
      },
      search ? 150 : 0,
    );
    return () => {
      current = false;
      clearTimeout(timer);
    };
  }, [open, kind, search, projectId, sessionId]);
  useEffect(() => {
    onOpenChange?.(open && !disabled);
    return () => onOpenChange?.(false);
  }, [open, disabled, onOpenChange]);
  const selectedType = contextTypes.find((type) => type.id === kind);
  return (
    <Popover
      isOpen={open && !disabled}
      onOpenChange={(next) => {
        setOpen(next && !disabled);
        if (next) {
          onOpen();
          setKind(null);
          setSearch("");
          setError("");
        }
      }}
    >
      <Popover.Trigger<"button">
        render={(props) => <button {...props} type="button" />}
        disabled={disabled}
        aria-label={zh ? "添加上下文" : "Add context"}
        className="agent-dock-composer-chip inline-flex size-7 shrink-0 items-center justify-center rounded-full"
      >
        <Plus size={16} />
      </Popover.Trigger>
      <Popover.Content
        placement="top start"
        offset={8}
        className="session-context-picker"
      >
        {kind ? (
          <>
            <div className="session-context-picker-heading">
              <button
                type="button"
                aria-label={zh ? "返回上下文类型" : "Back to context types"}
                onClick={() => {
                  setKind(null);
                  setSearch("");
                }}
              >
                <ArrowLeft size={14} />
              </button>
              <span>{zh ? selectedType?.zh : selectedType?.en}</span>
            </div>
            <input
              key={kind}
              autoFocus
              aria-label={zh ? "搜索上下文" : "Search context"}
              placeholder={
                kind === "file"
                  ? zh
                    ? "搜索文件名或路径…"
                    : "Search file name or path…"
                  : zh
                    ? "搜索名称…"
                    : "Search by name…"
              }
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              className="session-context-picker-search"
            />
            <div className="session-context-picker-results">
              {options.map((ref) => {
                const added = references.some(
                  (item) => item.kind === ref.kind && item.id === ref.id,
                );
                return (
                  <button
                    type="button"
                    key={ref.id}
                    className="session-context-picker-option"
                    disabled={added || references.length >= 20}
                    onClick={() => {
                      onChange([
                        ...references,
                        { kind: ref.kind, id: ref.id, label: ref.label },
                      ]);
                      setOpen(false);
                    }}
                  >
                    {ref.kind === "file" && (
                      <FileTypeIcon path={ref.id} size={16} />
                    )}
                    <span className="session-context-picker-option-label">
                      {ref.label ?? ref.id}
                    </span>
                    {ref.kind === "file" && ref.recent && (
                      <small className="session-context-picker-recent">
                        {zh ? "近期访问" : "Recent"}
                      </small>
                    )}
                    {(added || (ref.label && ref.label !== ref.id)) && (
                      <small>
                        {added ? (zh ? "已添加" : "Added") : ref.id}
                      </small>
                    )}
                  </button>
                );
              })}
            </div>
            {loading && <p role="status">{zh ? "正在加载…" : "Loading…"}</p>}
            {!loading && error && <p role="alert">{error}</p>}
            {!loading && !error && !options.length && (
              <p role="status">{zh ? "没有匹配项" : "No matches"}</p>
            )}
            {references.length >= 20 && (
              <p role="status">
                {zh ? "最多添加 20 个上下文" : "Up to 20 references"}
              </p>
            )}
          </>
        ) : (
          <>
            <div className="session-context-picker-heading">
              {zh ? "添加上下文" : "Add context"}
            </div>
            {contextTypes
              .filter((type) => type.id !== "wiki" || wikiEnabled)
              .map(({ id, Icon, ...labels }) => {
                const unavailable =
                  backendId !== "native" && (id === "skill" || id === "mcp");
                return (
                  <button
                    type="button"
                    key={id}
                    disabled={unavailable}
                    className="session-context-picker-option"
                    onClick={() => setKind(id)}
                  >
                    <Icon size={15} />
                    <span>
                      {zh ? labels.zh : labels.en}
                      {unavailable && (
                        <small>
                          {zh
                            ? "由此后端的原生配置管理"
                            : "Managed by this backend"}
                        </small>
                      )}
                    </span>
                  </button>
                );
              })}
            <button
              type="button"
              className="session-context-picker-option"
              disabled={compactUnavailable || compacting}
              onClick={() => void handleCompact()}
            >
              {compacting ? (
                <Loader2 size={15} className="animate-spin" />
              ) : (
                <Minimize2 size={15} />
              )}
              <span>
                {compacting
                  ? zh
                    ? "正在压缩上下文…"
                    : "Compacting context…"
                  : zh
                    ? "强制压缩上下文"
                    : "Force compact context"}
                <small>{compactHint}</small>
              </span>
            </button>
            {compactMessage && (
              <p
                role="status"
                className="px-3 py-2 text-xs text-muted-foreground"
              >
                {compactMessage}
              </p>
            )}
            {error && (
              <p role="alert" className="px-3 py-2 text-xs text-destructive">
                {error}
              </p>
            )}
          </>
        )}
      </Popover.Content>
    </Popover>
  );
}
