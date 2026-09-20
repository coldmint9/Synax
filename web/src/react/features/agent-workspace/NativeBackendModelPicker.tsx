import { useEffect, useState } from "react";
import { Popover } from "@heroui/react";
import { ChevronDown } from "lucide-react";
import {
  agentRuntimeApi,
  type BackendId,
  type ReasoningEffort,
} from "../../../lib/api/agentRuntime";
import { useLocale } from "../../../hooks/useLocale";

export function NativeBackendModelPicker({
  backendId,
  model,
  onChange,
  disabled,
  onEffortsChange,
  nativeMetadata,
  onOpenChange,
}: {
  backendId: BackendId;
  model: string | null;
  onChange: (value: string) => void;
  disabled: boolean;
  onOpenChange?: (open: boolean) => void;
  onEffortsChange?: (efforts: ReasoningEffort[] | undefined) => void;
  nativeMetadata?: unknown;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const [open, setOpen] = useState(false),
    [loading, setLoading] = useState(false);
  const [models, setModels] = useState<
    Array<{ id: string; label: string; efforts?: string[] }>
  >([]);
  const [defaultModel, setDefaultModel] = useState<string | null>(null);
  useEffect(() => {
    onOpenChange?.(open && !disabled);
    return () => onOpenChange?.(false);
  }, [open, disabled, onOpenChange]);
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
        ["low", "medium", "high", "xhigh", "max"].includes(effort),
      ),
    );
  }, [model, models, defaultModel, onEffortsChange]);
  const [error, setError] = useState<string | null>(null);
  const load = () => {
    setLoading(true);
    setError(null);
    void agentRuntimeApi
      .listBackendModels(backendId)
      .then((result) => {
        setModels(result.models);
        setDefaultModel(result.defaultModel ?? null);
      })
      .catch((cause) =>
        setError(
          cause instanceof Error ? cause.message : "CLI is unavailable.",
        ),
      )
      .finally(() => setLoading(false));
  };
  return (
    <Popover
      isOpen={open && !disabled}
      onOpenChange={(next) => {
        setOpen(next);
        if (next && !models.length) load();
      }}
    >
      <Popover.Trigger<"button">
        render={(props) => <button {...props} type="button" />}
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
      </Popover.Trigger>
      <Popover.Content
        placement="top end"
        offset={8}
        className="w-72 rounded-xl border border-border bg-background p-3 shadow-lg"
      >
        <label className="block text-xs">
          {zh ? "原生模型 ID" : "Native model ID"}
          <input
            aria-label="Native model ID"
            list={`native-models-${backendId}`}
            value={model ?? "default"}
            onChange={(event) => onChange(event.target.value)}
            className="mt-2 h-8 w-full rounded-md border border-border bg-background px-2"
          />
        </label>
        <datalist id={`native-models-${backendId}`}>
          <option value="default" />
          {models.map((item) => (
            <option key={item.id} value={item.id}>
              {item.label}
            </option>
          ))}
        </datalist>
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
      </Popover.Content>
    </Popover>
  );
}
