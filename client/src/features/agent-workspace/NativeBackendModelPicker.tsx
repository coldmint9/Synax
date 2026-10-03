import { useEffect, useRef, useState } from "react";
import {
  Combobox,
  ComboboxInput,
  ComboboxOption,
  ComboboxOptions,
} from "@headlessui/react";
import {
  Popover,
  PopoverButton,
  PopoverPanel,
} from "@/shared/ui/ui/Popover";
import { OverlayStateObserver } from "@/shared/ui/ui/OverlayStateObserver";
import { ChevronDown } from "lucide-react";
import {
  agentRuntimeApi,
  type BackendId,
  type ReasoningEffort,
} from "../../adapters/transport/agentRuntime";
import { useLocale } from "../../shared/hooks/useLocale";

interface Props {
  backendId: BackendId;
  model: string | null;
  onChange: (value: string) => void;
  disabled: boolean;
  onOpenChange?: (open: boolean) => void;
  onEffortsChange?: (efforts: ReasoningEffort[] | undefined) => void;
  nativeMetadata?: unknown;
}

export function NativeBackendModelPicker(props: Props) {
  return (
    <Popover key={props.backendId}>
      {({ open, close }) => (
        <NativeModelContent {...props} open={open} close={close} />
      )}
    </Popover>
  );
}

function NativeModelContent({
  backendId,
  model,
  onChange,
  disabled,
  onEffortsChange,
  nativeMetadata,
  onOpenChange,
  open,
  close,
}: Props & { open: boolean; close: () => void }) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState("");
  const loaded = useRef(false);
  useEffect(() => {
    if (disabled && open) close();
  }, [disabled, open, close]);
  const [models, setModels] = useState<
    Array<{ id: string; label: string; efforts?: string[] }>
  >([]);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  const native = nativeMetadata as
    | {
        version?: string;
        model?: string;
        cwd?: string;
        sessionId?: string;
        auth?: { kind?: string; source?: string };
        instructionSources?: unknown;
      }
    | undefined;
  useEffect(() => {
    const selected =
      models.find(
        (item) =>
          item.id === (model && model !== "default" ? model : defaultModel),
      ) ??
      (model === "default"
        ? models.find((item) => item.id === "default")
        : undefined);
    onEffortsChange?.(
      selected?.efforts?.filter((effort): effort is ReasoningEffort =>
        ["none", "low", "medium", "high", "xhigh", "max"].includes(effort),
      ),
    );
  }, [model, models, defaultModel, onEffortsChange]);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!open) return;
    setQuery("");
    if (loaded.current) return;
    let active = true;
    setLoading(true);
    setError(null);
    void agentRuntimeApi
      .listBackendModels(backendId)
      .then((result) => {
        if (!active) return;
        loaded.current = true;
        setModels(result.models);
        setDefaultModel(result.defaultModel ?? null);
      })
      .catch((cause: unknown) => {
        if (active)
          setError(
            cause instanceof Error ? cause.message : "CLI is unavailable.",
          );
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open, backendId]);
  const search = query.trim().toLowerCase();
  const options = [
    { id: "default", label: zh ? "CLI 默认模型" : "CLI default" },
    ...models.filter((item) => item.id !== "default"),
  ].filter(
    (item) =>
      !search || `${item.id} ${item.label}`.toLowerCase().includes(search),
  );
  const custom = query.trim();
  return (
    <>
      <OverlayStateObserver open={open} onOpenChange={onOpenChange} />
      <PopoverButton
        disabled={disabled}
        aria-label={zh ? "CLI 模型" : "CLI model"}
        className="agent-dock-composer-chip agent-mode-trigger"
      >
        <span>
          {model && model !== "default"
            ? model
            : zh
              ? "CLI 默认模型"
              : "CLI default"}
        </span>
        <ChevronDown size={10} aria-hidden />
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
        anchor={{ to: "top end", gap: 8, padding: 8 }}
        className="w-72 rounded-xl border border-border bg-background p-3 shadow-lg"
      >
        <Combobox
          value={model ?? "default"}
          disabled={disabled}
          immediate
          onChange={(value) => {
            if (value) {
              onChange(value);
              close();
            }
          }}
        >
          <label className="block text-xs">
            {zh ? "原生模型 ID" : "Native model ID"}
            <ComboboxInput
              autoFocus
              aria-label="Native model ID"
              displayValue={(value: string) => value}
              onChange={(event) => {
                setQuery(event.target.value);
                onChange(event.target.value);
              }}
              className="mt-2 h-8 w-full rounded-md border border-border bg-background px-2"
            />
          </label>
          <ComboboxOptions
            modal={false}
            static
            aria-label={zh ? "CLI 模型" : "CLI models"}
            className="mt-2 max-h-48 overflow-auto text-xs"
          >
            {options.map((item) => (
              <ComboboxOption
                key={item.id}
                value={item.id}
                className="cursor-default rounded-md px-2 py-1.5 data-focus:bg-muted data-selected:text-primary"
              >
                {item.label}
                {item.id !== "default" && item.label !== item.id && (
                  <small className="ml-2 text-muted-foreground">
                    {item.id}
                  </small>
                )}
              </ComboboxOption>
            ))}
            {custom &&
              custom !== "default" &&
              !models.some((item) => item.id === custom) && (
                <ComboboxOption
                  value={custom}
                  className="cursor-default rounded-md px-2 py-1.5 data-focus:bg-muted"
                >
                  {zh ? "使用" : "Use"} {custom}
                </ComboboxOption>
              )}
          </ComboboxOptions>
        </Combobox>
        {loading && (
          <p className="mt-2 text-xs text-muted-foreground">
            {zh ? "正在读取 CLI 模型…" : "Reading CLI models…"}
          </p>
        )}
        {error && (
          <p role="alert" className="mt-2 text-xs text-danger">
            {error}
          </p>
        )}
        {native && (
          <dl className="mt-3 space-y-1 break-all text-[10px] text-muted-foreground">
            <dt>{zh ? "实际运行配置" : "Effective runtime"}</dt>
            <dd>
              CLI {native.version ?? "—"} · {native.model ?? "—"}
            </dd>
            <dd>{native.cwd}</dd>
            <dd>
              {zh ? "原生会话" : "Native session"}: {native.sessionId}
            </dd>
            {native.auth && (
              <dd>
                {native.auth.kind} · {native.auth.source}
              </dd>
            )}
            {Boolean(native.instructionSources) && (
              <dd>
                {zh ? "指令来源" : "Instructions"}:{" "}
                {JSON.stringify(native.instructionSources)}
              </dd>
            )}
          </dl>
        )}
        {backendId === "claude-code" && (
          <p className="mt-2 text-[10px] text-muted-foreground">
            {zh
              ? "使用 API / 网关 / 云端认证，不使用 claude.ai 订阅登录。仅继承原生设置中的模型和 API 环境配置。"
              : "API / gateway / cloud authentication only, not claude.ai subscription login. Only native model and API environment settings are inherited."}
          </p>
        )}
        <p className="mt-2 text-[10px] text-muted-foreground">
          {zh
            ? "默认隔离本机 MCP、插件与 Hooks；不会修改全局配置。"
            : "Local MCP/plugins/hooks are isolated by default; global config is not changed."}
        </p>
      </PopoverPanel>
    </>
  );
}
