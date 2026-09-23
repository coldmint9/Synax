import { useState } from "react";
import { Sparkles } from "lucide-react";
import type {
  GlobalConfig,
  UpdateGlobalConfigRequest,
} from "../../../../lib/contracts/config";
import { useLocale } from "../../../../hooks/useLocale";
import { buildAgentModelOptions } from "../../agent-workspace/composer/modelSelection";
import { SettingsCard } from "./SettingsCard";
import { SettingsSelect } from "./SettingsSelect";
import { FormRow } from "./FormRow";

export function InputOptimizationSettings({
  config,
  onUpdate,
}: {
  config: GlobalConfig;
  onUpdate: (patch: UpdateGlobalConfigRequest) => Promise<void>;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const { apiModels } = buildAgentModelOptions(
    config,
    config.providers.filter((provider) => provider.status !== "inactive"),
  );
  const selected = config.inputOptimizationModel || "default";
  const options = [
    {
      key: "default",
      label: zh ? "跟随当前选择的模型" : "Follow currently selected model",
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
      await onUpdate({ inputOptimizationModel: key === "default" ? "" : key });
      setSaved(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSaving(false);
    }
  };
  return (
    <SettingsCard
      title={zh ? "输入优化模型" : "Input optimization model"}
      icon={Sparkles}
    >
      <FormRow label={zh ? "LLM 模型" : "LLM model"}>
        <SettingsSelect
          className="w-72 max-w-[50vw]"
          selectedKey={selected}
          onSelectionChange={(key) => void changeModel(key)}
          isDisabled={saving}
          disallowEmptySelection
          aria-label={zh ? "输入优化模型" : "Input optimization model"}
          options={options}
        />
      </FormRow>
      <p className="px-4 pb-3 text-xs leading-relaxed text-muted-foreground">
        {zh
          ? "用于输入框的星星按钮，仅整理输入，不会发送或执行任务。CLI／ACP 会话请在此指定 API 模型。"
          : "Used by the sparkle button to clarify drafts without sending or executing them. For CLI / ACP sessions, select an API model here."}
      </p>
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
