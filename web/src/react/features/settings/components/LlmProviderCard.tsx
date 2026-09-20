import { Button } from "@heroui/react";
import { formatContextLimit } from "../../../../lib/formatTokens";
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  Pencil,
  ShieldCheck,
  Trash2,
} from "lucide-react";
import {
  PROVIDER_LOGO_ASSETS,
  REASONING_EFFORT_LABELS,
  apiFormatLabel,
  modelsWithContextLimit,
  type ApiProviderDraft,
} from "../lib/providerPresets";
import { ProviderLogo } from "../../../components/ProviderLogo";
import { IconSurface } from "../../../components/IconSurface";
import { useLocale } from "../../../../hooks/useLocale";
import { useProviderMetrics } from "../../../components/extension-metrics/useProviderMetrics";
import { ProviderMetricsSettings } from "./ProviderMetricsSettings";

interface LlmProviderCardProps {
  draft: ApiProviderDraft;
  isDefault: boolean;
  isSaved: boolean;
  saving: boolean;
  expanded: boolean;
  onToggleExpand: () => void;
  onEdit: () => void;
  onSetDefault: () => void;
  onRemove: () => void;
}

export function LlmProviderCard({
  draft,
  isDefault,
  isSaved,
  saving,
  expanded,
  onToggleExpand,
  onEdit,
  onSetDefault,
  onRemove,
}: LlmProviderCardProps) {
  const { t, locale } = useLocale();
  const metrics = useProviderMetrics(
    { providerId: draft.id },
    { enabled: isSaved },
  );
  const logo = PROVIDER_LOGO_ASSETS[draft.id];
  /** Models with their own input window: the 1M switch is configured per model. */
  const windowModels = modelsWithContextLimit(draft);
  const largestWindow = windowModels.reduce(
    (max, model) => Math.max(max, model.contextLimit),
    0,
  );

  return (
    <div className="settings-item overflow-hidden">
      <button
        type="button"
        className="flex w-full items-center gap-3 p-3 text-left transition-colors"
        onClick={onToggleExpand}
      >
        {logo ? (
          <ProviderLogo
            src={logo.src}
            alt={draft.label}
            invertOnDark={logo.invertOnDark}
          />
        ) : (
          <IconSurface tone="muted" size="xs">
            <span className="text-[10px] font-bold">
              {draft.label[0]?.toUpperCase()}
            </span>
          </IconSurface>
        )}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium text-foreground truncate">
              {draft.label}
            </span>
            {isDefault && (
              <span className="settings-chip">{t("llmCardDefault")}</span>
            )}
            {metrics.fields.length > 0 && (
              <span
                className="settings-chip shrink-0"
                title={
                  locale === "zh"
                    ? "自动发现的扩展参数"
                    : "Automatically discovered extension metrics"
                }
              >
                {locale === "zh"
                  ? `扩展参数 ${metrics.fields.length}`
                  : `${metrics.fields.length} metrics`}
              </span>
            )}
          </div>
          <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground truncate">
            <span className="truncate font-mono">{draft.model}</span>
            {windowModels.length > 0 && (
              <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-px text-[9px] font-medium text-primary">
                {`上下文 ${formatContextLimit(largestWindow)}${windowModels.length > 1 ? ` ×${windowModels.length}` : ""}`}
              </span>
            )}
          </div>
        </div>
        <StatusDot validating={draft.validating || saving} hasKey={isSaved} />
        {expanded ? (
          <ChevronDown size={14} className="text-muted-foreground" />
        ) : (
          <ChevronRight size={14} className="text-muted-foreground" />
        )}
      </button>

      {expanded && (
        <div className="space-y-2 border-t wiki-soft-rule p-3">
          <div className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 text-[11px]">
            <span className="text-muted-foreground">API Key</span>
            <span className="text-foreground font-mono truncate">
              {draft.apiKeyMasked || (draft.apiKey ? "••••••••" : "—")}
            </span>
            <span className="text-muted-foreground">Base URL</span>
            <span className="text-foreground font-mono truncate">
              {draft.baseUrl || "—"}
            </span>
            <span className="text-muted-foreground">协议</span>
            <span className="text-foreground">
              {apiFormatLabel(draft.format)}
            </span>
            <span className="text-muted-foreground">{t("llmCardModel")}</span>
            <span className="text-foreground font-mono truncate">
              {draft.model || "—"}
            </span>
            <span className="text-muted-foreground">上下文窗口</span>
            <span className="text-foreground font-mono truncate">
              {windowModels.length > 0
                ? windowModels
                    .map(
                      (model) =>
                        `${model.id} ${formatContextLimit(model.contextLimit)}`,
                    )
                    .join("、")
                : "—"}
            </span>
            <span className="text-muted-foreground">思考强度</span>
            <span className="text-foreground">
              {(draft.reasoningEfforts?.length ?? 0) > 0
                ? draft
                    .reasoningEfforts!.map((e) => REASONING_EFFORT_LABELS[e])
                    .join(" / ")
                : "不限制"}
            </span>
          </div>
          <ProviderMetricsSettings draft={draft} />
          <div className="flex items-center gap-2 pt-1">
            <Button size="sm" variant="secondary" onPress={onEdit}>
              <Pencil size={12} />
              编辑
            </Button>
            {isSaved && !isDefault && (
              <Button size="sm" variant="secondary" onPress={onSetDefault}>
                <ShieldCheck size={12} />
                {t("llmCardSetDefault")}
              </Button>
            )}
            <Button size="sm" variant="danger-soft" onPress={onRemove}>
              <Trash2 size={12} />
              {t("llmCardDelete")}
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}

function StatusDot({
  validating,
  hasKey,
}: {
  validating: boolean;
  hasKey: boolean;
}) {
  if (validating)
    return <Loader2 size={12} className="animate-spin text-muted-foreground" />;
  return (
    <div
      className={`h-2 w-2 rounded-full ${hasKey ? "bg-success" : "bg-muted-foreground/30"}`}
    />
  );
}
