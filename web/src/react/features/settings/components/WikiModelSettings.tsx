import { useState } from "react";
import { BookOpen } from "lucide-react";
import type {
  GlobalConfig,
  UpdateGlobalConfigRequest,
} from "../../../../lib/contracts/config";
import { useLocale } from "../../../../hooks/useLocale";
import { useShellStore } from "../../../state/shellStore";
import { buildAgentModelOptions } from "../../agent-workspace/composer/modelSelection";
import { SettingsCard } from "./SettingsCard";
import { SettingsSelect } from "./SettingsSelect";
import { FormRow } from "./FormRow";

export function WikiModelSettings({
  config,
  onUpdate,
}: {
  config: GlobalConfig;
  onUpdate: (patch: UpdateGlobalConfigRequest) => Promise<void>;
}) {
  const enabled = useShellStore((state) => state.preferences.wikiEnabled);
  const { locale } = useLocale();
  const zh = locale === "zh";
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  if (!enabled) return null;
  const { apiModels } = buildAgentModelOptions(
    config,
    config.providers.filter((provider) => provider.status !== "inactive"),
  );
  const selected = config.wikiModel || "default";
  const options = [
    {
      key: "default",
      label: zh ? "跟随项目／系统默认" : "Use project / system default",
    },
    ...apiModels.map((model) => ({
      key: `${model.providerId}/${model.modelId}`,
      label: `${config.providers.find((provider) => provider.id === model.providerId)?.label ?? model.providerId} · ${model.modelId}`,
    })),
  ];
  if (
    selected !== "default" &&
    !options.some((option) => option.key === selected)
  )
    options.push({
      key: selected,
      label: `${selected} (${zh ? "当前不可用" : "unavailable"})`,
    });
  const changeModel = async (key: string | null) => {
    if (!key || key === selected || saving) return;
    setSaving(true);
    setSaved(false);
    setError(null);
    try {
      await onUpdate({ wikiModel: key === "default" ? "" : key });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <SettingsCard
      title={zh ? "Wiki 工作流模型" : "Wiki workflow model"}
      icon={BookOpen}
    >
      <p
        role="note"
        className="border-b border-border/50 px-4 py-3 text-xs leading-relaxed text-warning"
      >
        {zh
          ? "⚠️ 该功能会消耗大量 token，谨慎使用，后续可能会重构。"
          : "⚠️ This feature consumes a large number of tokens. Use with caution; it may be reworked in the future."}
      </p>
      <FormRow
        label={zh ? "LLM 模型" : "LLM model"}
        description={
          zh
            ? "用于后续 Wiki 生成、更新、规划和校验。"
            : "Used for subsequent Wiki generation, updates, planning and verification."
        }
      >
        <SettingsSelect
          className="w-72 max-w-full"
          selectedKey={selected}
          onSelectionChange={(key) => void changeModel(key)}
          isDisabled={saving}
          disallowEmptySelection
          aria-label={zh ? "Wiki 工作流模型" : "Wiki workflow model"}
          options={options}
        />
      </FormRow>
      {!apiModels.length && (
        <p className="px-4 pb-3 text-xs text-muted-foreground">
          {zh
            ? "请先在 LLM Provider 中配置可用模型。"
            : "Configure an available model under LLM Provider first."}
        </p>
      )}
      {error && (
        <p role="alert" className="px-4 pb-3 text-xs text-danger">
          {error}
        </p>
      )}
      {(saving || saved) && (
        <p role="status" className="px-4 pb-3 text-xs text-muted-foreground">
          {saving ? (zh ? "保存中…" : "Saving…") : zh ? "已保存" : "Saved"}
        </p>
      )}
    </SettingsCard>
  );
}
