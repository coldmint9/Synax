import { useEffect, useRef, useState, type ReactNode } from "react";
import { Check, Eye, EyeOff, Loader2, Search } from "lucide-react";
import {
  Dialog,
  DialogContainer,
  DialogPanel,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
} from "@/shared/ui/ui/Dialog";
import {
  Description,
  FieldError,
  InputGroup,
  Label,
  Field,
  Input,
  InputSuffix,
} from "@/shared/ui/ui/Field";
import { Button } from "@/shared/ui/ui/Button";
import { Checkbox } from "@/shared/ui/ui/Toggle";
import {
  ALL_REASONING_EFFORTS,
  API_FORMAT_OPTIONS,
  API_PROVIDER_PRESETS,
  REASONING_EFFORT_LABELS,
  applyProtocolDefaults,
  configuredModelList,
  mergeModelOptions,
  parseReasoningEfforts,
  selectDefaultModel,
  type ApiProviderDraft,
} from "../lib/providerPresets";
import { validateProviderDraft } from "../lib/validation";
import { useLocale } from "../../../shared/hooks/useLocale";
import { SettingsSelect } from "./SettingsSelect";
import { SaveIndicator } from "./SaveIndicator";
import { ProviderModelCapabilities } from "./ProviderModelCapabilities";
import type { ApiFormat } from "../../../shared/contracts/config";

interface LlmProviderModalProps {
  draft: ApiProviderDraft;
  isNew?: boolean;
  onClose: () => void;
  onSave: (draft: ApiProviderDraft) => Promise<void>;
  onValidate: (draft: ApiProviderDraft) => Promise<void>;
  onDiscoverModels: (draft: ApiProviderDraft) => Promise<{
    models: string[];
    metadata?: Record<string, import("../lib/providerPresets").ModelMeta>;
  }>;
}

function Advanced({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="border-t border-border pt-4" aria-labelledby={`${title}-section`}>
      <h3 id={`${title}-section`} className="text-sm font-medium text-foreground">
        {title}
      </h3>
      <div className="space-y-4 pt-4">{children}</div>
    </section>
  );
}

export function LlmProviderModal({
  draft: initialDraft,
  isNew = false,
  onClose,
  onSave,
  onValidate,
  onDiscoverModels,
}: LlmProviderModalProps) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  // The parent reloads config after saving. Keep this dialog's mode stable until it closes.
  const [creating] = useState(isNew);
  const [draft, setDraft] = useState<ApiProviderDraft>(() => ({
    ...initialDraft,
    reasoningEfforts: parseReasoningEfforts(initialDraft.reasoningEfforts),
  }));
  const [step, setStep] = useState<1 | 2>(1);
  const [showApiKey, setShowApiKey] = useState(false);
  const [presetId, setPresetId] = useState(
    initialDraft.custom ? "custom" : initialDraft.id,
  );
  const [modelQuery, setModelQuery] = useState("");
  const [manualModel, setManualModel] = useState("");
  const [attempted, setAttempted] = useState(false);
  const [discovering, setDiscovering] = useState(false);
  const [discoveryMessage, setDiscoveryMessage] = useState("");
  const [discoveryFailed, setDiscoveryFailed] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validationMessage, setValidationMessage] = useState("");
  const [validationFailed, setValidationFailed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const busyRef = useRef(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const keyRef = useRef<HTMLInputElement>(null);
  const errors = validateProviderDraft(draft);
  const connectionErrors = errors.filter((e) => e.field !== "model");
  const fieldError = (field: string) =>
    attempted
      ? connectionErrors.find((e) => e.field === field)?.message
      : undefined;
  const configuredModels = configuredModelList(draft);
  const candidates = mergeModelOptions(draft.modelOptions, configuredModels);
  const filtered = candidates.filter((model) =>
    model.toLowerCase().includes(modelQuery.trim().toLowerCase()),
  );
  const saving = submitting;
  const busy = saving || discovering || validating;
  const saveError = submitError;

  useEffect(() => {
    if (step === 2) searchRef.current?.focus();
  }, [step]);

  function changeConnection(patch: Partial<ApiProviderDraft>) {
    setDraft((current) => ({ ...current, ...patch }));
    setValidationMessage("");
    setDiscoveryMessage("");
  }

  function selectModel(model: string, checked: boolean) {
    setDraft((current) => {
      const models = checked
        ? mergeModelOptions(configuredModelList(current), [model])
        : configuredModelList(current).filter((id) => id !== model);
      return {
        ...current,
        models,
        model: models.includes(current.model)
          ? current.model
          : (models[0] ?? ""),
      };
    });
    setValidationMessage("");
  }

  function checkConnectionFields() {
    setAttempted(true);
    if (!connectionErrors.length) return true;
    if (connectionErrors[0].field === "apiKey") keyRef.current?.focus();
    else addressRef.current?.focus();
    return false;
  }

  async function discover() {
    if (busyRef.current || !checkConnectionFields()) return;
    busyRef.current = true;
    setDiscovering(true);
    setDiscoveryFailed(false);
    setDiscoveryMessage("");
    try {
      const discovered = await onDiscoverModels(draft);
      const models = mergeModelOptions(discovered.models);
      setDraft((current) => ({
        ...current,
        modelMeta: { ...current.modelMeta, ...(discovered.metadata ?? {}) },
        modelOptions: mergeModelOptions(
          models,
          current.modelOptions,
          configuredModelList(current),
        ),
      }));
      setDiscoveryMessage(
        models.length
          ? zh
            ? `发现 ${models.length} 个模型`
            : `Found ${models.length} models`
          : zh
            ? "未发现模型，请手动添加模型 ID。"
            : "No models found. Add a model ID manually.",
      );
    } catch (error) {
      setDiscoveryFailed(true);
      setDiscoveryMessage(
        `${error instanceof Error ? error.message : zh ? "获取模型失败" : "Could not load models"} · ${zh ? "可以重试或手动添加模型。" : "Retry or add a model manually."}`,
      );
    } finally {
      busyRef.current = false;
      setDiscovering(false);
      setStep(2);
    }
  }

  async function validate() {
    if (busyRef.current || errors.length) return;
    busyRef.current = true;
    setValidating(true);
    setValidationMessage("");
    setValidationFailed(false);
    try {
      await onValidate(draft);
      setValidationMessage(zh ? "连接成功" : "Connection successful");
    } catch (error) {
      setValidationFailed(true);
      setValidationMessage(
        error instanceof Error
          ? error.message
          : zh
            ? "连接失败"
            : "Connection failed",
      );
    } finally {
      busyRef.current = false;
      setValidating(false);
    }
  }

  async function close() {
    if (busy || busyRef.current) return;
    onClose();
  }

  async function save() {
    if (busyRef.current || errors.length) return;
    busyRef.current = true;
    setSubmitting(true);
    setSubmitError(null);
    try {
      if (creating) {
        await onSave(draft);
        onClose();
      } else {
        await onSave(draft);
        onClose();
      }
    } catch (error) {
      setSubmitError(
        error instanceof Error
          ? error.message
          : zh
            ? "保存失败，请重试"
            : "Could not save. Please retry.",
      );
    } finally {
      busyRef.current = false;
      setSubmitting(false);
    }
  }

  function addModel() {
    const value = manualModel.trim();
    if (!value) return;
    setDraft((current) => {
      const model =
        mergeModelOptions(
          current.modelOptions,
          configuredModelList(current),
        ).find((m) => m.toLowerCase() === value.toLowerCase()) ?? value;
      return {
        ...current,
        model: current.model || model,
        models: mergeModelOptions(configuredModelList(current), [model]),
        modelOptions: mergeModelOptions(current.modelOptions, [model]),
      };
    });
    setManualModel("");
    setModelQuery("");
  }

  return (
    <Dialog open dismissible={false} onClose={() => void close()}>
      <DialogContainer size="lg">
        <DialogPanel>
          <DialogHeader>
            <div className="space-y-2">
              <DialogTitle>
                {creating
                  ? step === 1
                    ? zh
                      ? "连接供应商"
                      : "Connect provider"
                    : zh
                      ? "选择模型"
                      : "Choose models"
                  : `${draft.label} ${zh ? "配置" : "settings"}`}
              </DialogTitle>
              <p className="text-sm text-muted-foreground">
                {step === 1
                  ? zh
                    ? "填好连接信息，再选择要使用的模型。"
                    : "Connect your provider, then choose the models to use."
                  : zh
                    ? "只添加你要使用的模型，并选择一个默认模型。"
                    : "Choose the models you need and set a default."}
              </p>
              <ol
                className="flex gap-6 pt-2 text-sm"
                aria-label={zh ? "配置步骤" : "Setup steps"}
              >
                {[zh ? "连接" : "Connection", zh ? "模型" : "Models"].map(
                  (label, i) => (
                    <li
                      key={label}
                      aria-current={step === i + 1 ? "step" : undefined}
                      className={
                        step === i + 1
                          ? "font-medium text-foreground"
                          : "text-muted-foreground"
                      }
                    >
                      <span
                        className={`mr-2 inline-flex size-6 items-center justify-center rounded-full ${step === i + 1 ? "bg-primary text-primary-foreground" : "bg-muted"}`}
                      >
                        {i + 1}
                      </span>
                      {label}
                    </li>
                  ),
                )}
              </ol>
            </div>
          </DialogHeader>
          <DialogBody>
            <fieldset
              disabled={busy}
              className="min-w-0 space-y-5 disabled:opacity-70"
            >
              {step === 1 ? (
                <>
                  {creating && initialDraft.custom ? (
                    <SettingsSelect
                      label={zh ? "供应商" : "Provider"}
                      selectedKey={presetId}
                      onSelectionChange={(value) => {
                        if (!value) return;
                        setPresetId(value);
                        const preset = API_PROVIDER_PRESETS.find(
                          (p) => p.providerId === value,
                        );
                        changeConnection({
                          label: preset?.label ?? initialDraft.label,
                          baseUrl: preset?.defaultBaseUrl ?? "",
                          format: preset?.format ?? "openai",
                          model: "",
                          models: [],
                          modelOptions: [],
                          modelMeta: {},
                        });
                      }}
                      options={[
                        {
                          key: "custom",
                          label: zh
                            ? "自定义 · OpenAI 兼容"
                            : "Custom · OpenAI compatible",
                        },
                        ...API_PROVIDER_PRESETS.map((p) => ({
                          key: p.providerId,
                          label: p.label,
                        })),
                      ]}
                    />
                  ) : (
                    <p className="text-sm font-medium">{draft.label}</p>
                  )}
                  <Field invalid={!!fieldError("baseUrl")}>
                    <Label>{zh ? "服务地址" : "Service URL"}</Label>
                    <Input
                      ref={addressRef}
                      autoFocus
                      type="url"
                      value={draft.baseUrl}
                      placeholder="https://api.example.com/v1"
                      onChange={(event) =>
                        changeConnection({ baseUrl: event.currentTarget.value })
                      }
                    />
                    {fieldError("baseUrl") ? (
                      <FieldError>{fieldError("baseUrl")}</FieldError>
                    ) : (
                      <Description>
                        {zh
                          ? "填写供应商提供的 API 地址。"
                          : "Enter the API URL supplied by your provider."}
                      </Description>
                    )}
                  </Field>
                  <Field invalid={!!fieldError("apiKey")}>
                    <Label>API Key</Label>
                    <InputGroup>
                      <Input
                        ref={keyRef}
                        type={showApiKey ? "text" : "password"}
                        autoComplete="off"
                        value={draft.apiKey}
                        placeholder={draft.apiKeyMasked || "sk-…"}
                        onChange={(event) =>
                          changeConnection({
                            apiKey: event.currentTarget.value,
                          })
                        }
                      />
                      <InputSuffix>
                        <button
                          type="button"
                          className="rounded p-1 focus-visible:outline-2 focus-visible:outline-ring"
                          aria-label={
                            showApiKey
                              ? zh
                                ? "隐藏 API Key"
                                : "Hide API key"
                              : zh
                                ? "显示 API Key"
                                : "Show API key"
                          }
                          aria-pressed={showApiKey}
                          onClick={() => setShowApiKey((v) => !v)}
                        >
                          {showApiKey ? (
                            <EyeOff size={16} />
                          ) : (
                            <Eye size={16} />
                          )}
                        </button>
                      </InputSuffix>
                    </InputGroup>
                    {fieldError("apiKey") && (
                      <FieldError>{fieldError("apiKey")}</FieldError>
                    )}
                    {draft.apiKeyMasked && (
                      <Description>
                        {zh
                          ? "留空以继续使用已保存的密钥。"
                          : "Leave blank to keep the saved key."}
                      </Description>
                    )}
                  </Field>
                  <Advanced
                    title={zh ? "高级连接设置" : "Advanced connection settings"}
                  >
                    <Field>
                      <Label>{zh ? "显示名称" : "Display name"}</Label>
                      <Input
                        value={draft.label}
                        onChange={(event) =>
                          changeConnection({ label: event.currentTarget.value })
                        }
                      />
                    </Field>
                    <div className="space-y-2">
                      <SettingsSelect
                        label={zh ? "API 协议" : "API protocol"}
                        selectedKey={draft.format}
                        options={API_FORMAT_OPTIONS.map((option) => ({
                          key: option.key,
                          label: option.label,
                        }))}
                        onSelectionChange={(value) => {
                          const next = applyProtocolDefaults(
                            draft,
                            value as ApiFormat,
                          );
                          changeConnection(next);
                        }}
                      />
                      {draft.format === "jev" ? (
                        <Description>
                          {zh
                            ? "Jev / TypeSafe System One：OpenRouter 地址使用 https://openrouter.ai/api（也接受 /api/v1，会在验证时归一化）；模型填写 jev-latest 或其他 System One 模型 ID，不要填写 chat 模型。"
                            : "Jev / TypeSafe System One: use https://openrouter.ai/api for OpenRouter (the /api/v1 form is normalized during validation); use a System One model such as jev-latest, not a chat model."}
                        </Description>
                      ) : null}
                    </div>
                  </Advanced>
                </>
              ) : (
                <>
                  <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
                    <span className="text-muted-foreground">
                      {zh
                        ? `已选择 ${configuredModels.length} 个模型`
                        : `${configuredModels.length} models selected`}
                    </span>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => void discover()}
                    >
                      {zh ? "重新获取模型" : "Refresh models"}
                    </Button>
                  </div>
                  {discoveryMessage && (
                    <p
                      role="status"
                      className={`text-sm ${discoveryFailed ? "text-destructive" : "text-muted-foreground"}`}
                    >
                      {discoveryMessage}
                    </p>
                  )}
                  <Field>
                    <Label className="sr-only">
                      {zh ? "搜索模型" : "Search models"}
                    </Label>
                    <InputGroup>
                      <Input
                        ref={searchRef}
                        type="search"
                        placeholder={zh ? "搜索模型…" : "Search models…"}
                        value={modelQuery}
                        onChange={(event) =>
                          setModelQuery(event.currentTarget.value)
                        }
                      />
                      <InputSuffix>
                        <Search size={16} />
                      </InputSuffix>
                    </InputGroup>
                  </Field>
                  <div
                    className="max-h-64 space-y-1 overflow-y-auto"
                    aria-label={zh ? "模型列表" : "Models"}
                  >
                    {filtered.map((model) => (
                      <div
                        key={model}
                        className="flex min-w-0 items-center gap-3 rounded-lg px-2 py-2 hover:bg-muted/50"
                      >
                        <Field className="!flex min-w-0 flex-1 items-center gap-3">
                          <Checkbox
                            checked={configuredModels.includes(model)}
                            onChange={(checked) => selectModel(model, checked)}
                          />
                          <Label className="min-w-0 cursor-pointer break-all text-sm">
                            {model}
                          </Label>
                        </Field>
                        {configuredModels.includes(model) && (
                          <Button
                            variant="ghost"
                            size="sm"
                            aria-label={`${model} ${zh ? "设为默认" : "Set as default"}`}
                            aria-pressed={draft.model === model}
                            onClick={() => {
                              setDraft((current) =>
                                selectDefaultModel(current, model),
                              );
                              setValidationMessage("");
                            }}
                            className="shrink-0"
                          >
                            {draft.model === model ? (
                              <>
                                <Check size={14} />
                                {zh ? "默认" : "Default"}
                              </>
                            ) : zh ? (
                              "设为默认"
                            ) : (
                              "Set default"
                            )}
                          </Button>
                        )}
                      </div>
                    ))}
                    {!filtered.length && (
                      <p className="py-5 text-center text-sm text-muted-foreground">
                        {zh
                          ? "没有匹配的模型，可以手动添加。"
                          : "No matching models. Add one manually."}
                      </p>
                    )}
                  </div>
                  <Advanced title={zh ? "手动添加模型" : "Add model manually"}>
                    <Field>
                      <Label>{zh ? "模型 ID" : "Model ID"}</Label>
                      <Input
                        placeholder={
                          zh
                            ? "供应商提供的模型 ID"
                            : "Model ID from your provider"
                        }
                        value={manualModel}
                        onChange={(event) =>
                          setManualModel(event.currentTarget.value)
                        }
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            addModel();
                          }
                        }}
                      />
                    </Field>
                    <Button
                      variant="secondary"
                      disabled={!manualModel.trim()}
                      onClick={addModel}
                    >
                      {zh ? "添加到列表" : "Add to list"}
                    </Button>
                  </Advanced>
                  <Advanced
                    title={zh ? "高级模型设置" : "Advanced model settings"}
                  >
                    <ProviderModelCapabilities
                      draft={draft}
                      onChange={setDraft}
                      zh={zh}
                    />
                    <fieldset className="space-y-2">
                      <legend className="mb-2 text-sm">
                        {zh
                          ? "供应商允许的思考强度"
                          : "Allowed reasoning efforts"}
                      </legend>
                      <div className="flex flex-wrap gap-3">
                        {ALL_REASONING_EFFORTS.map((effort) => (
                          <Field
                            key={effort}
                            className="!flex items-center gap-2"
                          >
                            <Checkbox
                              checked={draft.reasoningEfforts.includes(effort)}
                              onChange={(checked) =>
                                setDraft((current) => ({
                                  ...current,
                                  reasoningEfforts: parseReasoningEfforts(
                                    checked
                                      ? [...current.reasoningEfforts, effort]
                                      : current.reasoningEfforts.filter(
                                          (e) => e !== effort,
                                        ),
                                  ),
                                }))
                              }
                            />
                            <Label className="cursor-pointer text-sm">
                              {zh ? REASONING_EFFORT_LABELS[effort] : effort}
                            </Label>
                          </Field>
                        ))}
                      </div>
                      <p className="text-xs text-muted-foreground">
                        {zh
                          ? "不勾选时允许全部档位。输入框始终按强度从低到高排列。"
                          : "Leave empty to allow all levels. The composer always orders levels from low to high."}
                      </p>
                    </fieldset>
                  </Advanced>
                  <div className="flex flex-wrap items-center gap-3">
                    <Button
                      variant="secondary"
                      size="sm"
                      disabled={errors.length > 0}
                      onClick={() => void validate()}
                    >
                      {validating
                        ? zh
                          ? "测试中…"
                          : "Testing…"
                        : zh
                          ? "测试连接"
                          : "Test connection"}
                    </Button>
                    {validationMessage && (
                      <span
                        role="status"
                        className={`text-sm ${validationFailed ? "text-destructive" : "text-muted-foreground"}`}
                      >
                        {validationMessage}
                      </span>
                    )}
                  </div>
                </>
              )}
            </fieldset>
            {saveError && (
              <p role="alert" className="mt-4 text-sm text-destructive">
                {saveError}
              </p>
            )}
          </DialogBody>
          <DialogFooter className="flex-wrap">
            {!creating && (
              <SaveIndicator
                saving={false}
                saved={false}
                error={null}
              />
            )}
            <Button
              variant="ghost"
              disabled={busy}
              onClick={() => void close()}
            >
              {creating ? (zh ? "取消" : "Cancel") : zh ? "关闭" : "Close"}
            </Button>
            {step === 1 ? (
              <>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    if (checkConnectionFields()) setStep(2);
                  }}
                >
                  {zh
                    ? creating
                      ? "手动添加"
                      : "管理模型"
                    : creating
                      ? "Add manually"
                      : "Manage models"}
                </Button>
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => void discover()}
                >
                  {discovering && (
                    <Loader2 size={14} className="animate-spin" />
                  )}
                  {discovering
                    ? zh
                      ? "获取模型中…"
                      : "Loading models…"
                    : zh
                      ? "连接并获取模型"
                      : "Connect and load models"}
                </Button>
              </>
            ) : (
              <>
                <Button
                  variant="secondary"
                  disabled={busy}
                  onClick={() => {
                    setStep(1);
                    setModelQuery("");
                  }}
                >
                  {zh ? "上一步" : "Back"}
                </Button>
                <Button
                  variant="primary"
                  disabled={busy || errors.length > 0}
                  onClick={() => void save()}
                >
                  {saving && <Loader2 size={14} className="animate-spin" />}
                  {creating
                      ? zh
                        ? "添加供应商"
                        : "Add provider"
                      : zh
                        ? "完成"
                        : "Done"}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogPanel>
      </DialogContainer>
    </Dialog>
  );
}
