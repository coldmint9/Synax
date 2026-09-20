import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Plus,
  RefreshCw,
  SlidersHorizontal,
} from "lucide-react";
import { useLocale } from "../../../hooks/useLocale";
import type { ProviderMetricField } from "../../../lib/api/providerMetrics";

interface ExtensionMetricsProps {
  fields: ProviderMetricField[];
  loading?: boolean;
  error?: string | null;
  pending?: Set<string>;
  onUpdate: (
    field: ProviderMetricField,
    patch: { visible?: boolean; accumulate?: boolean },
  ) => Promise<void>;
  onRefresh?: () => void;
  /** Settings show all discovered fields; runtime initially shows selected fields. */
  configuration?: boolean;
  scope?: "session" | "provider";
  selectionOpen?: boolean;
  onSelectionToggle?: () => void;
}

function formatValue(
  value: ProviderMetricField["lastValue"],
  locale: string,
): string {
  if (value === undefined || value === null) return "—";
  if (typeof value === "number") {
    if (!Number.isFinite(value)) return "—";
    return new Intl.NumberFormat(locale === "zh" ? "zh-CN" : "en-US", {
      maximumSignificantDigits: 10,
    }).format(value);
  }
  if (typeof value === "boolean")
    return locale === "zh" ? (value ? "是" : "否") : String(value);
  return value || (locale === "zh" ? "（空）" : "(empty)");
}

/** Generic renderer for provider-declared and response-observed scalar metrics. */
export function ExtensionMetrics({
  fields,
  loading,
  error,
  pending,
  onUpdate,
  onRefresh,
  configuration = false,
  scope = "provider",
  selectionOpen,
  onSelectionToggle,
}: ExtensionMetricsProps) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const [localEditing, setLocalEditing] = useState(false);
  const editing = selectionOpen ?? localEditing;
  const toggleSelection =
    onSelectionToggle ?? (() => setLocalEditing((value) => !value));
  const showControls = configuration || editing;
  const shown = showControls ? fields : fields.filter((field) => field.visible);
  const multipleProviders =
    new Set(fields.map((field) => field.providerId)).size > 1;

  return (
    <section
      aria-label={zh ? "扩展参数" : "Extension metrics"}
      className="space-y-2 rounded-lg border border-border/40 p-2"
    >
      <div className="flex items-center gap-1.5">
        <SlidersHorizontal
          size={11}
          className="shrink-0 text-muted-foreground"
          aria-hidden
        />
        <span className="min-w-0 flex-1 text-[11px] font-medium text-foreground/85">
          {zh ? "扩展参数" : "Extension metrics"}
        </span>
        {fields.length > 0 && (
          <span className="rounded bg-primary/10 px-1.5 py-px text-[9px] text-primary">
            {zh ? `已发现 ${fields.length}` : `${fields.length} discovered`}
          </span>
        )}
        {onRefresh && (
          <button
            type="button"
            onClick={onRefresh}
            disabled={loading}
            aria-label={zh ? "刷新扩展参数" : "Refresh extension metrics"}
            className="rounded p-1 text-muted-foreground hover:bg-muted/50 disabled:opacity-40"
          >
            <RefreshCw size={11} className={loading ? "animate-spin" : ""} />
          </button>
        )}
      </div>
      {!configuration && fields.length > 0 && (
        <button
          type="button"
          onClick={toggleSelection}
          aria-expanded={editing}
          className="flex items-center gap-1 text-[10px] text-primary"
        >
          {editing ? (
            <ChevronDown size={11} />
          ) : shown.length ? (
            <ChevronRight size={11} />
          ) : (
            <Plus size={11} />
          )}
          {editing
            ? zh
              ? "收起参数选择"
              : "Close metric selection"
            : shown.length
              ? zh
                ? "管理参数"
                : "Manage metrics"
              : zh
                ? "添加参数"
                : "Add metrics"}
        </button>
      )}
      {error && (
        <p role="alert" className="break-words text-[10px] text-danger">
          {zh ? "扩展参数暂不可用：" : "Metrics unavailable: "}
          {error}
        </p>
      )}
      {loading && fields.length === 0 && (
        <p role="status" className="text-[10px] text-muted-foreground">
          {zh ? "正在发现参数…" : "Discovering metrics…"}
        </p>
      )}
      {!loading && !error && fields.length === 0 && (
        <p className="text-[10px] leading-relaxed text-muted-foreground">
          {zh
            ? "尚未发现扩展参数。供应商声明或后续响应中的新参数会自动出现在这里。"
            : "No extension metrics yet. Provider declarations and new fields in future responses will appear here."}
        </p>
      )}
      {!showControls && fields.length > 0 && shown.length === 0 && (
        <p className="text-[10px] text-muted-foreground">
          {zh
            ? "选择要在运行情况中显示的参数。"
            : "Choose metrics to display in runtime details."}
        </p>
      )}
      <div className="space-y-2">
        {shown.map((field) => {
          const busy = pending?.has(field.id);
          return (
            <div
              key={field.id}
              className="min-w-0 space-y-1 border-t border-border/30 pt-2 first:border-0 first:pt-0"
            >
              <div className="flex items-start gap-1.5">
                {showControls && (
                  <input
                    type="checkbox"
                    checked={field.visible}
                    disabled={busy}
                    onChange={(event) => {
                      void onUpdate(field, { visible: event.target.checked });
                    }}
                    aria-label={
                      zh ? `显示 ${field.label}` : `Show ${field.label}`
                    }
                    className="mt-0.5 size-3 shrink-0 accent-primary"
                  />
                )}
                <div className="min-w-0 flex-1">
                  <div className="flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                    <span className="break-words text-[10px] font-medium text-foreground/85">
                      {field.label}
                    </span>
                    <span className="text-[9px] text-muted-foreground">
                      {field.source === "declared"
                        ? zh
                          ? "供应商声明"
                          : "Provider declared"
                        : zh
                          ? "自动发现"
                          : "Auto-discovered"}
                    </span>
                  </div>
                  <p
                    className="break-all font-mono text-[9px] text-muted-foreground/75"
                    title={field.path}
                  >
                    {multipleProviders && <span>{field.providerId} · </span>}
                    {field.path}
                  </p>
                </div>
              </div>
              <dl className="space-y-1 text-[10px]">
                <div className="flex items-start justify-between gap-2">
                  <dt className="shrink-0 text-muted-foreground">
                    {zh ? "最近记录" : "Latest recorded"}
                  </dt>
                  <dd className="min-w-0 break-all text-right tabular-nums text-foreground/85">
                    {formatValue(field.lastValue, locale)}
                    {field.lastValue !== undefined && field.unit && (
                      <span className="ml-1 text-muted-foreground">
                        {field.unit}
                      </span>
                    )}
                  </dd>
                </div>
                {field.type === "number" && field.accumulate && (
                  <div className="flex items-start justify-between gap-2">
                    <dt className="shrink-0 text-muted-foreground">
                      {scope === "session"
                        ? zh
                          ? "本会话累计"
                          : "Session total"
                        : zh
                          ? "已记录累计"
                          : "Recorded total"}
                    </dt>
                    <dd className="min-w-0 break-all text-right font-medium tabular-nums text-foreground">
                      {formatValue(field.total, locale)}
                      {field.total !== undefined && field.unit && (
                        <span className="ml-1 font-normal text-muted-foreground">
                          {field.unit}
                        </span>
                      )}
                    </dd>
                  </div>
                )}
              </dl>
              {showControls && field.type === "number" && (
                <label className="flex cursor-pointer items-center gap-1.5 text-[10px] text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={field.accumulate}
                    disabled={busy}
                    onChange={(event) => {
                      void onUpdate(field, {
                        accumulate: event.target.checked,
                      });
                    }}
                    aria-label={
                      zh ? `累计 ${field.label}` : `Accumulate ${field.label}`
                    }
                    className="size-3 accent-primary"
                  />
                  {zh ? "累计已记录的数值" : "Sum recorded values"}
                </label>
              )}
              {field.count > 0 && (
                <p className="text-[9px] text-muted-foreground/70">
                  {zh ? `${field.count} 条记录` : `${field.count} observations`}
                </p>
              )}
            </div>
          );
        })}
      </div>
      {showControls && fields.some((field) => field.type === "number") && (
        <p className="text-[9px] leading-relaxed text-muted-foreground/75">
          {zh
            ? "显示与累计设置自动保存；累计包含启用前的已记录值。缺失值不按 0 计算。"
            : "Display and total settings save automatically. Totals include earlier recorded values; missing values are not counted as zero."}
        </p>
      )}
    </section>
  );
}
