import { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  Combobox,
  ComboboxInput,
  ComboboxOption,
  ComboboxOptions,
  Radio,
  RadioGroup,
} from "@headlessui/react";
import {
  Popover,
  PopoverButton,
  PopoverPanel,
} from "@/react/components/ui/Popover";
import { OverlayStateObserver } from "@/react/components/ui/OverlayStateObserver";
import {
  Check,
  Paperclip,
  MessageCircle,
  Target,
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
  type AgentSessionMode,
  type TurnReference,
  type TurnReferenceOption,
} from "../../../lib/api/agentRuntime";
import { useShellStore } from "../../state/shellStore";
import { useLocale } from "../../../hooks/useLocale";
import { FileTypeIcon } from "./FileTypeIcon";
import { useAgentSessionStore } from "./state/agentSessionStore";
import { sessionCompaction } from "./sessionCompaction";

const contextTypes = [
  { id: "skill", zh: "技能", en: "Skill", Icon: Sparkles },
  { id: "mcp", zh: "MCP 服务", en: "MCP server", Icon: Plug },
  { id: "file", zh: "项目文件", en: "Project file", Icon: FileText },
  { id: "wiki", zh: "Wiki 文档", en: "Wiki document", Icon: BookOpen },
] as const;

interface Props {
  projectId: string;
  sessionId?: string;
  backendId: string;
  references: TurnReference[];
  onChange: (references: TurnReference[]) => void;
  disabled: boolean;
  compactDisabled?: boolean;
  onOpen: () => void;
  onOpenChange?: (open: boolean) => void;
  onAttachFiles?: (files: File[]) => void;
  mode?: AgentSessionMode | "plan_node";
  modeDisabled?: boolean;
  onModeChange?: (mode: AgentSessionMode) => void;
}

export function ComposerContextPicker(props: Props) {
  return (
    <Popover
      key={`${props.projectId}:${props.sessionId ?? ""}:${props.backendId}`}
    >
      {({ open, close }) => (
        <ContextPickerContent {...props} open={open} close={close} />
      )}
    </Popover>
  );
}

function ContextPickerContent({
  projectId,
  sessionId,
  backendId,
  references,
  onChange,
  disabled,
  compactDisabled,
  onOpen,
  onOpenChange,
  onAttachFiles,
  mode,
  modeDisabled = false,
  onModeChange,
  open,
  close,
}: Props & { open: boolean; close: () => void }) {
  const wikiEnabled = useShellStore((s) => s.preferences.wikiEnabled);
  const { locale } = useLocale(),
    zh = locale === "zh";
  const attachmentInput = useRef<HTMLInputElement>(null);
  const hasModes = backendId === "native" && Boolean(mode && onModeChange);
  const unified = Boolean(onAttachFiles || hasModes);
  const selectedMode = mode === "plan" ? "chat" : mode;
  const modeOptions = [
    { id: "chat", label: zh ? "对话" : "Chat", Icon: MessageCircle },
    { id: "goal", label: zh ? "目标" : "Goal", Icon: Target },
  ] as const;
  const [kind, setKind] = useState<TurnReference["kind"] | null>(null);
  const typeButtons = useRef<
    Partial<Record<TurnReference["kind"], HTMLButtonElement | null>>
  >({});
  const returnFocusTo = useRef<TurnReference["kind"] | null>(null);
  useLayoutEffect(() => {
    if (!open) {
      returnFocusTo.current = null;
    } else if (!kind && returnFocusTo.current) {
      typeButtons.current[returnFocusTo.current]?.focus({ preventScroll: true });
      returnFocusTo.current = null;
    }
  }, [kind, open]);
  const [search, setSearch] = useState("");
  const [options, setOptions] = useState<TurnReferenceOption[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [compactSubmitting, setCompactSubmitting] = useState(false);
  const compactionNotice = useAgentSessionStore((s) =>
    s.selectedSessionId === sessionId ? s.contextCompactionNotice : null,
  );
  const compactRunning = useAgentSessionStore(
    (s) =>
      sessionCompaction(s.sessions.find((item) => item.id === sessionId))
        ?.status === "running" || compactionNotice?.status === "running",
  );
  const compacting =
    compactRunning ||
    (compactSubmitting &&
      compactionNotice?.status !== "completed" &&
      compactionNotice?.status !== "failed");
  const compactRequest = useRef(0);
  const compactPending = useRef(false);
  useEffect(() => {
    compactRequest.current += 1;
    compactPending.current = false;
    setCompactSubmitting(false);
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
    if (
      !sessionId ||
      compactUnavailable ||
      compacting ||
      compactPending.current
    )
      return;
    compactPending.current = true;
    const request = ++compactRequest.current;
    setCompactSubmitting(true);
    setError("");
    close();
    useAgentSessionStore.setState({
      contextCompactionNotice: { status: "running" },
    });
    try {
      await agentRuntimeApi.compactContext(sessionId);
    } catch (err) {
      if (
        request === compactRequest.current &&
        useAgentSessionStore.getState().selectedSessionId === sessionId &&
        useAgentSessionStore.getState().contextCompactionNotice?.status ===
          "running"
      ) {
        const message = err instanceof Error ? err.message : String(err);
        useAgentSessionStore.setState({
          contextCompactionNotice: { status: "failed", error: message },
        });
      }
    } finally {
      if (request === compactRequest.current) {
        compactPending.current = false;
        setCompactSubmitting(false);
      }
    }
  };
  const previousWikiEnabled = useRef(wikiEnabled);
  useEffect(() => {
    if (open && (disabled || previousWikiEnabled.current !== wikiEnabled))
      close();
    previousWikiEnabled.current = wikiEnabled;
  }, [open, disabled, wikiEnabled, close]);
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
  const selectedType = contextTypes.find((type) => type.id === kind);
  return (
    <>
      {onAttachFiles && (
        <input
          ref={attachmentInput}
          type="file"
          multiple
          hidden
          disabled={disabled}
          onChange={(event) => {
            const files = Array.from(event.target.files ?? []);
            event.target.value = "";
            if (!disabled && files.length) onAttachFiles(files);
          }}
        />
      )}
      <OverlayStateObserver
        open={open}
        onOpenChange={(next) => {
          onOpenChange?.(next);
          if (next) {
            onOpen();
            setKind(null);
            setSearch("");
            setError("");
          }
        }}
      />
      <PopoverButton
        disabled={disabled}
        aria-label={
          unified
            ? zh
              ? "添加附件、上下文或切换模式"
              : "Add attachments, context or change mode"
            : zh
              ? "添加上下文"
              : "Add context"
        }
        aria-description={
          hasModes
            ? `${zh ? "当前模式：" : "Current mode: "}${modeOptions.find((option) => option.id === selectedMode)?.label ?? (zh ? "计划节点" : "Plan node")}`
            : undefined
        }
        className="agent-dock-composer-chip inline-flex size-7 shrink-0 items-center justify-center rounded-full"
      >
        <Plus size={16} aria-hidden="true" />
      </PopoverButton>
      <PopoverPanel
        onKeyDownCapture={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            event.stopPropagation();
            close();
          }
        }}
        focus
        anchor={{ to: "top start", gap: 8, padding: 8 }}
        className="session-context-picker"
      >
        {kind ? (
          <Combobox
            key={kind}
            value={null as TurnReferenceOption | null}
            immediate
              onChange={(ref) => {
              if (
                !ref ||
                disabled ||
                references.length >= 20 ||
                references.some(
                  (item) => item.kind === ref.kind && item.id === ref.id,
                )
              )
                return;
              onChange([
                ...references,
                { kind: ref.kind, id: ref.id, label: ref.label },
              ]);
              close();
            }}
          >
            <div className="session-context-picker-heading">
              <button
                type="button"
                aria-label={zh ? "返回上下文类型" : "Back to context types"}
                onClick={() => {
                  returnFocusTo.current = kind;
                  setKind(null);
                  setSearch("");
                }}
              >
                <ArrowLeft size={14} />
              </button>
              <span>{zh ? selectedType?.zh : selectedType?.en}</span>
            </div>
            <ComboboxInput
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
              displayValue={() => search}
              onChange={(event) => setSearch(event.target.value)}
              className="session-context-picker-search"
            />
            <ComboboxOptions
            modal={false}
              static
              aria-label={zh ? "上下文" : "Context"}
              className="session-context-picker-results"
            >
              {options.map((ref) => {
                const added = references.some(
                  (item) => item.kind === ref.kind && item.id === ref.id,
                );
                return (
                  <ComboboxOption
                    value={ref}
                    key={ref.id}
                    className="session-context-picker-option data-focus:bg-muted data-disabled:opacity-50"
                    disabled={added || references.length >= 20}
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
                  </ComboboxOption>
                );
              })}
            </ComboboxOptions>
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
          </Combobox>
        ) : (
          <>
            {onAttachFiles && (
              <button
                type="button"
                className="session-context-picker-option"
                onClick={() => {
                  attachmentInput.current?.click();
                  close();
                }}
              >
                <Paperclip size={15} aria-hidden="true" />
                <span>
                  {zh ? "添加附件" : "Attach files"}
                  <small>
                    {zh
                      ? "图片、音频、视频、PDF 或文件"
                      : "Images, audio, video, PDFs or files"}
                  </small>
                </span>
              </button>
            )}
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
                    ref={(button) => {
                      typeButtons.current[id] = button;
                    }}
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
            {hasModes && (
              <RadioGroup
                value={mode === "plan_node" ? "chat" : selectedMode}
                disabled={disabled || modeDisabled || mode === "plan_node"}
                onChange={(id: AgentSessionMode) => {
                  close();
                  if (id !== selectedMode) onModeChange?.(id);
                }}
                className="session-composer-mode-group"
                aria-label={zh ? "工作模式" : "Work mode"}
              >
                <div className="session-context-picker-heading">
                  {zh ? "工作模式" : "Work mode"}
                </div>
                {modeOptions.map(({ id, label, Icon }) => (
                  <Radio
                    as="button"
                    type="button"
                    key={id}
                    value={id}
                    aria-label={label}
                    className="session-context-picker-option session-composer-mode-option"
                    data-mode={id}
                  >
                    <Icon size={15} aria-hidden="true" />
                    <span>{label}</span>
                    {(mode === id ||
                      (id === "chat" && mode === "plan_node")) && (
                      <Check size={14} className="ms-auto" aria-hidden="true" />
                    )}
                  </Radio>
                ))}
              </RadioGroup>
            )}
            <button
              type="button"
              className="session-context-picker-option"
              disabled={compactUnavailable || compacting}
              onClick={() => void handleCompact()}
            >
              {compacting ? (
                <Loader2
                  size={15}
                  aria-hidden="true"
                  className="animate-spin motion-reduce:animate-none"
                />
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
            {error && (
              <p role="alert" className="px-3 py-2 text-xs text-destructive">
                {error}
              </p>
            )}
          </>
        )}
      </PopoverPanel>
    </>
  );
}
