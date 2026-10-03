import { Field, Input, Label, Description } from "@/shared/ui/ui/Field";
import { Checkbox } from "@/shared/ui/ui/Toggle";
import { Button } from "@/shared/ui/ui/Button";
import { SettingsSelect } from "./SettingsSelect";
import {
  configuredModelList,
  toggleModelContextLimit,
  type ApiProviderDraft,
  type DeclaredModelModality,
} from "../lib/providerPresets";
import { useState } from "react";
import type { MediaAdapter, MediaOperation, ModelCapability } from "../../../shared/contracts/media-generation";

const MODALITIES = [
  { id: "text", zh: "文本", en: "Text" },
  { id: "image", zh: "图片", en: "Image" },
  { id: "audio", zh: "音频", en: "Audio" },
  { id: "video", zh: "视频", en: "Video" },
] as const satisfies ReadonlyArray<{ id: DeclaredModelModality; zh: string; en: string }>;
const GENERATION_CAPABILITIES: Array<{ id: ModelCapability; zh: string; en: string }> = [
  { id: "chat", zh: "对话", en: "Chat" },
  { id: "image_generation", zh: "生图", en: "Image generation" },
  { id: "video_generation", zh: "生视频", en: "Video generation" },
];
const MEDIA_OPERATIONS: Array<{ id: MediaOperation; zh: string; en: string }> = [
  { id: "text-to-image", zh: "文生图", en: "Text to image" },
  { id: "image-to-image", zh: "图生图", en: "Image to image" },
  { id: "text-to-video", zh: "文生视频", en: "Text to video" },
  { id: "image-to-video", zh: "图生视频", en: "Image to video" },
];

type Props = {
  draft: ApiProviderDraft;
  onChange: (update: (current: ApiProviderDraft) => ApiProviderDraft) => void;
  zh: boolean;
};

/** Overrides belong to the selected model; changing models never copies capabilities. */
export function ProviderModelCapabilities({ draft, onChange, zh }: Props) {
  const models = configuredModelList(draft);
  const [selectedModel, setSelectedModel] = useState(draft.model);
  const [parameterName, setParameterName] = useState("");
  const model = models.includes(selectedModel) ? selectedModel : models[0];
  if (!model) return null;
  const meta = draft.modelMeta[model] ?? {};
  const hasOverrides =
    meta.inputModalities !== undefined ||
    meta.outputModalities !== undefined ||
    meta.contextLimit !== undefined ||
    meta.capabilities !== undefined ||
    meta.media !== undefined;

  const capabilities = meta.capabilities ?? (meta.media
    ? [
        ...(meta.media.operations.some((operation) => operation.endsWith("image")) ? ["image_generation" as ModelCapability] : []),
        ...(meta.media.operations.some((operation) => operation.endsWith("video")) ? ["video_generation" as ModelCapability] : []),
      ]
    : ["chat" as ModelCapability]);
  const operations = meta.media?.operations ?? [];

  function toggleCapability(capability: ModelCapability, checked: boolean) {
    onChange((current) => {
      const metadata = current.modelMeta[model] ?? {};
      const currentCapabilities = metadata.capabilities ?? capabilities;
      const nextCapabilities = checked
        ? [...new Set([...currentCapabilities, capability])]
        : currentCapabilities.filter((value) => value !== capability);
      const nextOperations = (metadata.media?.operations ?? []).filter((operation) =>
        operation.endsWith("image") ? nextCapabilities.includes("image_generation") : nextCapabilities.includes("video_generation"),
      );
      if (checked && capability === "image_generation" && !nextOperations.some((operation) => operation.endsWith("image"))) nextOperations.push("text-to-image");
      if (checked && capability === "video_generation" && !nextOperations.some((operation) => operation.endsWith("video"))) nextOperations.push("text-to-video");
      return {
        ...current,
        modelMeta: {
          ...current.modelMeta,
          [model]: {
            ...metadata,
            capabilities: nextCapabilities.length ? nextCapabilities : ["chat"],
            media: nextOperations.length ? { ...(metadata.media ?? {}), operations: nextOperations } : undefined,
          },
        },
      };
    });
  }

  function toggleOperation(operation: MediaOperation, checked: boolean) {
    onChange((current) => {
      const metadata = current.modelMeta[model] ?? {};
      const nextOperations = checked
        ? [...new Set([...(metadata.media?.operations ?? []), operation])]
        : (metadata.media?.operations ?? []).filter((value) => value !== operation);
      if (!nextOperations.some((value) => value.endsWith(operation.endsWith("image") ? "image" : "video"))) return current;
      return {
        ...current,
        modelMeta: {
          ...current.modelMeta,
          [model]: {
            ...metadata,
            media: {
              ...(metadata.media ?? {}),
              operations: nextOperations,
            },
          },
        },
      };
    });
  }

  function updateParameter(key: string, values: Array<string | number | boolean> | undefined) {
    onChange((current) => {
      const metadata = current.modelMeta[model] ?? {};
      const parameters = { ...(metadata.media?.parameters ?? {}) };
      if (values) parameters[key] = { ...parameters[key], values };
      else delete parameters[key];
      return { ...current, modelMeta: { ...current.modelMeta, [model]: {
        ...metadata, media: { ...metadata.media!, operations: metadata.media?.operations ?? [], parameters },
      } } };
    });
  }

  function toggle(
    direction: "inputModalities" | "outputModalities",
    modality: DeclaredModelModality,
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
      <fieldset className="space-y-2">
        <legend className="text-sm">{zh ? "生成能力" : "Generation capabilities"}</legend>
        <div className="flex flex-wrap gap-x-4 gap-y-2">
          {GENERATION_CAPABILITIES.map((option) => (
            <Field key={option.id} className="!flex items-center gap-2">
              <Checkbox
                checked={capabilities.includes(option.id)}
                onChange={(checked) => toggleCapability(option.id, checked)}
                aria-label={`${model} ${zh ? option.zh : option.en}`}
              />
              <Label className="text-sm">{zh ? option.zh : option.en}</Label>
            </Field>
          ))}
        </div>
      </fieldset>
      {capabilities.some((capability) => capability !== "chat") && (
        <fieldset className="space-y-3">
          <legend className="text-sm">{zh ? "媒体操作" : "Media operations"}</legend>
          <SettingsSelect
            label={zh ? "媒体协议适配器" : "Media adapter"}
            selectedKey={draft.mediaAdapter ?? null}
            onSelectionChange={(value) => onChange((current) => ({ ...current, mediaAdapter: value as MediaAdapter | undefined ?? undefined }))}
            options={(["openai", "xai", "ark", "minimax", "openrouter"] as const).map((id) => ({ key: id, label: id }))}
            fullWidth
          />
          <div className="flex flex-wrap gap-x-4 gap-y-2">
            {MEDIA_OPERATIONS.map((option) => {
              const visible = option.id.endsWith("image")
                ? capabilities.includes("image_generation")
                : capabilities.includes("video_generation");
              if (!visible) return null;
              return (
                <Field key={option.id} className="!flex items-center gap-2">
                  <Checkbox
                    checked={operations.includes(option.id)}
                    onChange={(checked) => toggleOperation(option.id, checked)}
                    aria-label={`${model} ${zh ? option.zh : option.en}`}
                  />
                  <Label className="text-sm">{zh ? option.zh : option.en}</Label>
                </Field>
              );
            })}
          </div>
          <div className="space-y-2">
            <Label>{zh ? "模型参数" : "Model parameters"}</Label>
            {Object.entries(meta.media?.parameters ?? {}).map(([key, parameter]) => (
              <Field key={key} className="!flex flex-wrap items-center gap-2">
                <Label className="min-w-20 text-xs">{key}</Label>
                <Input
                  aria-label={`${key} values`}
                  value={(parameter.values ?? []).join(", ")}
                  placeholder={zh ? "可选值，以逗号分隔" : "Values, comma separated"}
                  onChange={(event) => updateParameter(key, event.target.value.split(",").map((value) => value.trim()).filter(Boolean))}
                />
                <Button variant="ghost" size="sm" onClick={() => updateParameter(key, undefined)}>{zh ? "移除" : "Remove"}</Button>
              </Field>
            ))}
            <Field className="!flex items-center gap-2">
              <Input aria-label={zh ? "参数名称" : "Parameter name"} value={parameterName} onChange={(event) => setParameterName(event.target.value)} />
              <Button variant="secondary" size="sm" disabled={!parameterName.trim() || Boolean(meta.media?.parameters?.[parameterName.trim()])} onClick={() => { updateParameter(parameterName.trim(), []); setParameterName(""); }}>{zh ? "添加参数" : "Add parameter"}</Button>
            </Field>
          </div>
        </fieldset>
      )}
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
                  capabilities: undefined,
                  media: undefined,
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
