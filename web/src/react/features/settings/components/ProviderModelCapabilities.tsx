import { Field, Label, Description } from "@/react/components/ui/Field";
import { Checkbox } from "@/react/components/ui/Toggle";
import { Button } from "@/react/components/ui/Button";
import { SettingsSelect } from "./SettingsSelect";
import {
  configuredModelList,
  toggleModelContextLimit,
  type ApiProviderDraft,
} from "../lib/providerPresets";
import { useState } from "react";

const MODALITIES = [
  { id: "text", zh: "文本", en: "Text" },
  { id: "image", zh: "图片", en: "Image" },
  { id: "audio", zh: "音频", en: "Audio" },
  { id: "video", zh: "视频", en: "Video" },
  { id: "file", zh: "文件", en: "File" },
] as const;
type Modality = (typeof MODALITIES)[number]["id"];

type Props = {
  draft: ApiProviderDraft;
  onChange: (update: (current: ApiProviderDraft) => ApiProviderDraft) => void;
  zh: boolean;
};

/** Overrides belong to the selected model; changing models never copies capabilities. */
export function ProviderModelCapabilities({ draft, onChange, zh }: Props) {
  const models = configuredModelList(draft);
  const [selectedModel, setSelectedModel] = useState(draft.model);
  const model = models.includes(selectedModel) ? selectedModel : models[0];
  if (!model) return null;
  const meta = draft.modelMeta[model] ?? {};
  const hasOverrides =
    meta.inputModalities !== undefined ||
    meta.outputModalities !== undefined ||
    meta.contextLimit !== undefined;

  function toggle(
    direction: "inputModalities" | "outputModalities",
    modality: Modality,
    checked: boolean,
  ) {
    onChange((current) => {
      const metadata = current.modelMeta[model] ?? {};
      const values = metadata[direction] ?? [];
      return {
        ...current,
        modelMeta: {
          ...current.modelMeta,
          [model]: {
            ...metadata,
            [direction]: checked
              ? [...new Set([...values, modality])]
              : values.filter((value) => value !== modality),
          },
        },
      };
    });
  }

  return (
    <div className="space-y-4">
      <SettingsSelect
        label={zh ? "配置模型" : "Configure model"}
        selectedKey={model}
        onSelectionChange={(value) => value && setSelectedModel(value)}
        options={models.map((id) => ({ key: id, label: id }))}
        fullWidth
      />
      <p className="text-xs text-muted-foreground">
        {zh
          ? "未覆盖的能力沿用模型目录声明。修改仅影响当前模型。"
          : "Capabilities follow the model catalog unless overridden. Changes apply only to this model."}
      </p>
      {(["inputModalities", "outputModalities"] as const).map((direction) => (
        <fieldset key={direction} className="space-y-2">
          <legend className="text-sm">
            {direction === "inputModalities"
              ? zh
                ? "输入能力"
                : "Input capabilities"
              : zh
                ? "输出能力"
                : "Output capabilities"}
          </legend>
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {MODALITIES.map((option) => (
              <Field key={option.id} className="!flex items-center gap-2">
                <Checkbox
                  checked={(meta[direction] ?? []).includes(option.id)}
                  onChange={(checked) => toggle(direction, option.id, checked)}
                  aria-label={`${model} ${direction === "inputModalities" ? (zh ? "输入" : "input") : zh ? "输出" : "output"} ${zh ? option.zh : option.en}`}
                />
                <Label className="text-sm">{zh ? option.zh : option.en}</Label>
              </Field>
            ))}
          </div>
        </fieldset>
      ))}
      <Field className="!flex flex-wrap items-center gap-2">
        <Checkbox
          checked={meta.contextLimit === 1_000_000}
          onChange={(checked) =>
            onChange((current) =>
              toggleModelContextLimit(current, model, checked),
            )
          }
        />
        <Label className="text-sm">
          {zh ? "输入上下文窗口支持 1M" : "1M input context window"}
        </Label>
        <Description className="w-full">
          {zh
            ? "仅为确认支持 1M 输入窗口的模型开启。"
            : "Enable only for models with a confirmed 1M input window."}
        </Description>
      </Field>
      {hasOverrides && (
        <Button
          variant="ghost"
          size="sm"
          onClick={() =>
            onChange((current) => ({
              ...current,
              modelMeta: {
                ...current.modelMeta,
                [model]: {
                  ...current.modelMeta[model],
                  inputModalities: undefined,
                  outputModalities: undefined,
                  contextLimit: undefined,
                },
              },
            }))
          }
        >
          {zh ? "恢复目录默认能力" : "Reset to catalog defaults"}
        </Button>
      )}
    </div>
  );
}
