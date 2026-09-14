import { useState } from 'react'
import { Button, Checkbox, Description, FieldError, InputGroup, Label, Modal, TextField } from '@heroui/react'
import { Check, ChevronDown, Eye, EyeOff, Plus, RefreshCw, Save, Search, Wifi, X } from 'lucide-react'
import {
  ALL_REASONING_EFFORTS,
  API_FORMAT_OPTIONS,
  REASONING_EFFORT_LABELS,
  applyProtocolDefaults,
  configuredModelList,
  mergeModelOptions,
  selectDefaultModel,
  toggleModelSelection,
  type ApiProviderDraft,
} from '../lib/providerPresets'
import { validateProviderDraft } from '../lib/validation'
import { useLocale } from '../../../../hooks/useLocale'
import { SettingsSelect } from './SettingsSelect'
import type { ApiFormat, ReasoningEffort } from '../../../../lib/contracts/config'

interface LlmProviderModalProps {
  draft: ApiProviderDraft
  onClose: () => void
  onSave: (draft: ApiProviderDraft) => Promise<void>
  onValidate: (draft: ApiProviderDraft) => Promise<void>
  onDiscoverModels: (draft: ApiProviderDraft) => Promise<string[]>
}

export function LlmProviderModal({
  draft: initialDraft,
  onClose,
  onSave,
  onValidate,
  onDiscoverModels,
}: LlmProviderModalProps) {
  const { t } = useLocale()
  const [draft, setDraft] = useState<ApiProviderDraft>({ ...initialDraft })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  const [showApiKey, setShowApiKey] = useState(false)
  const [modelMenuOpen, setModelMenuOpen] = useState(false)
  const [modelQuery, setModelQuery] = useState('')

  const errors = validateProviderDraft(draft)
  const fieldError = (field: string) => errors.find(e => e.field === field)?.message

  const selectedModelHas1M = draft.modelMeta?.[draft.model]?.contextLimit === 1_000_000
  /** Models this provider would configure (the multi-select result). */
  const configuredModels = configuredModelList(draft)
  /** Picker candidates: discovered models plus whatever is already configured. */
  const candidateModels = mergeModelOptions(draft.modelOptions, configuredModels)
  const normalizedQuery = modelQuery.trim().toLowerCase()
  const filteredCandidates = normalizedQuery
    ? candidateModels.filter(m => m.toLowerCase().includes(normalizedQuery))
    : candidateModels
  const hasExactCandidate = candidateModels.some(m => m.toLowerCase() === normalizedQuery)

  async function handleSave() {
    if (errors.length > 0) return
    setSaving(true)
    setSaveError(null)
    try {
      await onSave(draft)
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  async function handleValidate() {
    setDraft(d => ({ ...d, validating: true, validationMessage: null }))
    try {
      await onValidate(draft)
      setDraft(d => ({ ...d, validating: false, validationMessage: '✓ 连接成功' }))
    } catch (err) {
      setDraft(d => ({
        ...d,
        validating: false,
        validationMessage: err instanceof Error ? err.message : '连接失败',
      }))
    }
  }

  async function handleDiscover() {
    setDraft(d => ({ ...d, discoveringModels: true, modelMessage: null }))
    try {
      const models = await onDiscoverModels(draft)
      if (models.length > 0) {
        // Discovery only fills the candidate pool; the user picks what to configure.
        setDraft(d => ({
          ...d,
          discoveringModels: false,
          modelOptions: mergeModelOptions(models, d.modelOptions, configuredModelList(d)),
          modelMessage: `发现 ${models.length} 个模型，勾选需要启用的模型`,
        }))
        setModelMenuOpen(true)
      } else {
        setDraft(d => ({ ...d, discoveringModels: false, modelMessage: '未发现可用模型' }))
      }
    } catch (err) {
      setDraft(d => ({
        ...d,
        discoveringModels: false,
        modelMessage: err instanceof Error ? err.message : '发现失败',
      }))
    }
  }

  /** Multi-select toggle: adds or removes a candidate from the configured models. */
  function handleToggleModel(model: string) {
    setDraft(d => toggleModelSelection(
      { ...d, modelOptions: mergeModelOptions(d.modelOptions, [model]) },
      model,
    ))
  }

  function handleSetDefaultModel(model: string) {
    setDraft(d => selectDefaultModel(
      { ...d, modelOptions: mergeModelOptions(d.modelOptions, [model]) },
      model,
    ))
  }

  /** Enter or "添加" turns the typed text into a configured model and the default one. */
  function addQueryModel() {
    const typed = modelQuery.trim()
    if (!typed) return
    setDraft(d => {
      const known = mergeModelOptions(d.modelOptions, configuredModelList(d))
        .find(m => m.toLowerCase() === typed.toLowerCase())
      const model = known ?? typed
      return {
        ...d,
        model,
        models: mergeModelOptions(d.models, [model]),
        modelOptions: mergeModelOptions(d.modelOptions, [model]),
        modelMessage: null,
      }
    })
    setModelQuery('')
    setModelMenuOpen(false)
  }

  function toggleEffort(effort: ReasoningEffort) {
    setDraft(d => {
      const current = d.reasoningEfforts ?? []
      const next = current.includes(effort)
        ? current.filter(e => e !== effort)
        : [...current, effort]
      return { ...d, reasoningEfforts: next }
    })
  }

  function toggle1M(checked: boolean) {
    setDraft(d => {
      const modelMeta = {
        ...(d.modelMeta ?? {}),
        [d.model]: { ...(d.modelMeta?.[d.model] ?? {}), contextLimit: checked ? 1_000_000 : undefined },
      }
      return { ...d, modelMeta }
    })
  }

  return (
    <Modal.Backdrop isOpen onOpenChange={(open) => { if (!open) onClose() }}>
      <Modal.Container size="lg">
        <Modal.Dialog>
          <Modal.Header>
            <Modal.Heading>{draft.custom ? draft.label : `${draft.label} 配置`}</Modal.Heading>
          </Modal.Header>
          <Modal.Body className="px-6">
            <div className="space-y-4">
              {draft.custom && (
                <TextField
                  value={draft.label}
                  onChange={(val) => setDraft(d => ({ ...d, label: val }))}
                >
                  <Label className="text-xs">Provider 名称</Label>
                  <InputGroup>
                    <InputGroup.Input placeholder="My Provider" />
                  </InputGroup>
                </TextField>
              )}

              <TextField
                isInvalid={!!fieldError('apiKey')}
                type={showApiKey ? 'text' : 'password'}
                value={draft.apiKey}
                onChange={(val) => setDraft(d => ({ ...d, apiKey: val }))}
              >
                <Label className="text-xs">
                  API Key <span className="text-destructive">*</span>
                </Label>
                <InputGroup>
                  <InputGroup.Input placeholder={draft.apiKeyMasked || t('llmCardApiKeyPlaceholder')} />
                  <InputGroup.Suffix className="pr-0">
                    <Button
                      isIconOnly
                      size="sm"
                      variant="ghost"
                      aria-label={showApiKey ? '隐藏' : '显示'}
                      onPress={() => setShowApiKey(!showApiKey)}
                    >
                      {showApiKey ? <EyeOff size={13} /> : <Eye size={13} />}
                    </Button>
                  </InputGroup.Suffix>
                </InputGroup>
                {fieldError('apiKey') && <FieldError>{fieldError('apiKey')}</FieldError>}
              </TextField>

              <SettingsSelect
                label="协议"
                selectedKey={draft.format}
                onSelectionChange={(key) => {
                  if (key) setDraft(d => applyProtocolDefaults(d, key as ApiFormat))
                }}
                disallowEmptySelection
                options={API_FORMAT_OPTIONS.map(option => ({ key: option.key, label: option.label }))}
              />

              <TextField
                isInvalid={!!fieldError('baseUrl')}
                value={draft.baseUrl}
                onChange={(val) => setDraft(d => ({ ...d, baseUrl: val }))}
              >
                <Label className="text-xs">Base URL</Label>
                <InputGroup>
                  <InputGroup.Input placeholder={draft.custom ? 'https://api.example.com' : undefined} />
                </InputGroup>
                {fieldError('baseUrl')
                  ? <FieldError>{fieldError('baseUrl')}</FieldError>
                  : draft.custom && <Description className="text-[11px]">无需包含 /v1，系统会自动检测</Description>
                }
              </TextField>

              <div className="space-y-1">
                <span className="block text-xs text-foreground pb-1">{t('llmCardModel')}</span>
                <div className="flex gap-1.5 items-end">
                  <div className="relative flex-1">
                    <div className={`flex h-9 items-center gap-2 rounded-lg border bg-transparent px-2.5 ${fieldError('model') ? 'border-destructive' : 'border-default'}`}>
                      <input
                        value={draft.model}
                        onChange={(e) => setDraft(d => ({ ...d, model: e.target.value }))}
                        placeholder="模型 ID"
                        aria-label={t('llmCardModel')}
                        className="h-full w-full bg-transparent font-mono text-xs text-foreground outline-none placeholder:text-muted-foreground/50"
                      />
                      <button
                        type="button"
                        aria-label="候选模型"
                        aria-expanded={modelMenuOpen}
                        onClick={() => setModelMenuOpen(o => !o)}
                        className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted/60"
                      >
                        <ChevronDown size={13} />
                      </button>
                    </div>
                    {modelMenuOpen && (
                      <div className="mt-1 w-full overflow-hidden rounded-lg border border-default bg-background shadow-lg">
                        <div className="flex items-center gap-1.5 border-b border-border/40 px-2">
                          <Search size={12} className="shrink-0 text-muted-foreground" />
                          <input
                            autoFocus
                            value={modelQuery}
                            onChange={(e) => setModelQuery(e.target.value)}
                            onKeyDown={(e) => {
                              if (e.key !== 'Enter') return
                              e.preventDefault()
                              addQueryModel()
                            }}
                            placeholder="搜索或输入模型…"
                            aria-label="搜索模型"
                            className="h-8 w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground/50"
                          />
                        </div>
                        <ul className="max-h-52 space-y-0.5 overflow-y-auto p-1.5">
                          {filteredCandidates.map(m => {
                            const selected = configuredModels.includes(m)
                            return (
                              <li key={m} className="flex items-center gap-1">
                                <button
                                  type="button"
                                  onClick={() => handleToggleModel(m)}
                                  aria-pressed={selected}
                                  className={`flex min-w-0 flex-1 items-center gap-2 rounded-full px-2.5 py-1.5 text-left text-[11px] transition-colors ${
                                    selected
                                      ? 'bg-primary/10 font-medium text-primary'
                                      : 'text-foreground/85 hover:bg-muted/60'
                                  }`}
                                >
                                  <span aria-hidden className={`flex h-3.5 w-3.5 shrink-0 items-center justify-center rounded border ${selected ? 'border-primary bg-primary text-primary-foreground' : 'border-border'}`}>
                                    {selected && <Check size={10} />}
                                  </span>
                                  <span className="truncate font-mono">{m}</span>
                                  {draft.modelMeta?.[m]?.contextLimit === 1_000_000 && (
                                    <span aria-hidden className="shrink-0 rounded-full bg-primary/10 px-1.5 py-px text-[9px] font-medium text-primary">1M</span>
                                  )}
                                </button>
                                {m === draft.model.trim() ? (
                                  <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-px text-[9px] font-medium text-primary">默认</span>
                                ) : (
                                  <button
                                    type="button"
                                    onClick={() => handleSetDefaultModel(m)}
                                    className="shrink-0 rounded-full px-2 py-1 text-[10px] text-muted-foreground transition-colors hover:bg-muted/60"
                                  >
                                    设为默认
                                  </button>
                                )}
                              </li>
                            )
                          })}
                          {normalizedQuery && !hasExactCandidate && (
                            <li>
                              <button
                                type="button"
                                onClick={addQueryModel}
                                className="flex w-full items-center gap-1.5 rounded-full px-2.5 py-1.5 text-left text-[11px] text-foreground/85 transition-colors hover:bg-muted/60"
                              >
                                <Plus size={11} className="shrink-0" />
                                {`添加 “${modelQuery.trim()}”`}
                              </button>
                            </li>
                          )}
                          {filteredCandidates.length === 0 && !normalizedQuery && (
                            <li className="px-2.5 py-2 text-center text-[10px] text-muted-foreground/60">暂无候选模型，点击“{t('llmCardDiscover')}”获取</li>
                          )}
                        </ul>
                        <div className="flex items-center justify-between gap-2 border-t border-border/40 px-2.5 py-1.5">
                          <span className="text-[10px] text-muted-foreground/70">勾选要启用的模型，输入新模型名后回车可新增</span>
                          <button
                            type="button"
                            onClick={() => setModelMenuOpen(false)}
                            className="shrink-0 rounded-full px-2 py-0.5 text-[10px] text-muted-foreground transition-colors hover:bg-muted/60"
                          >
                            完成
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                  <Button
                    size="sm"
                    variant="secondary"
                    isPending={draft.discoveringModels}
                    onPress={handleDiscover}
                  >
                    <RefreshCw size={12} />
                    {t('llmCardDiscover')}
                  </Button>
                </div>
                {fieldError('model') && <FieldError>{fieldError('model')}</FieldError>}
                {draft.modelMessage && (
                  <div className="text-[10px] text-muted-foreground">{draft.modelMessage}</div>
                )}
                <div className="flex flex-wrap items-center gap-1.5 pt-0.5">
                  <span className="text-[10px] text-muted-foreground/70">已启用模型</span>
                  {configuredModels.map(m => (
                    <span key={m} className="inline-flex items-center gap-1 rounded-full border border-border/50 px-2 py-0.5 text-[10px]">
                      <span className="font-mono">{m}</span>
                      {m === draft.model.trim() ? (
                        <span className="text-primary">默认</span>
                      ) : (
                        <button
                          type="button"
                          aria-label={`移除模型 ${m}`}
                          onClick={() => handleToggleModel(m)}
                          className="text-muted-foreground transition-colors hover:text-destructive"
                        >
                          <X size={10} />
                        </button>
                      )}
                    </span>
                  ))}
                </div>
              </div>

              <div className="flex items-center justify-between gap-2 rounded-lg border border-border/40 px-2.5 py-2">
                <div className="min-w-0">
                  <p className="text-xs font-medium text-foreground">输入上下文窗口支持 1M</p>
                  <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">
                    当前模型 {draft.model || '—'} 按 1,000,000 token 输入窗口计算，压缩/清窗阈值同步放大
                    {selectedModelHas1M ? '（已启用）' : ''}
                  </p>
                </div>
                <Checkbox
                  isSelected={selectedModelHas1M}
                  onChange={(checked) => toggle1M(Boolean(checked))}
                  aria-label="输入上下文窗口支持 1M"
                >
                  <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
                </Checkbox>
              </div>

              <div className="space-y-1.5">
                <span className="block text-xs text-foreground pb-0.5">允许的思考强度（可多选）</span>
                <div className="flex flex-wrap gap-1.5">
                  {ALL_REASONING_EFFORTS.map(effort => {
                    const selected = (draft.reasoningEfforts ?? []).includes(effort)
                    return (
                      <button
                        key={effort}
                        type="button"
                        onClick={() => toggleEffort(effort)}
                        aria-pressed={selected}
                        className={`inline-flex h-7 items-center rounded-full px-3 text-[11px] font-medium transition-colors ${
                          selected
                            ? 'bg-primary text-primary-foreground'
                            : 'border border-border/50 bg-transparent text-muted-foreground hover:bg-muted/40'
                        }`}
                      >
                        {REASONING_EFFORT_LABELS[effort]}
                      </button>
                    )
                  })}
                </div>
                <p className="text-[10px] leading-relaxed text-muted-foreground">
                  {draft.reasoningEfforts?.length
                    ? 'agent 输入框只能在这些已允许的档位中单选。'
                    : '未勾选 = 不限制，agent 输入框可选全部档位。'}
                </p>
              </div>

              {draft.validationMessage && (
                <div className={`text-[11px] rounded px-2 py-1.5 ${draft.validationMessage.startsWith('✓') ? 'bg-success/10 text-success' : 'bg-destructive/10 text-destructive'}`}>
                  {draft.validationMessage}
                </div>
              )}

              {saveError && (
                <div className="text-[11px] rounded px-2 py-1.5 bg-destructive/10 text-destructive">
                  {saveError}
                </div>
              )}
            </div>
          </Modal.Body>
          <Modal.Footer>
            <Button
              size="sm"
              variant="secondary"
              isPending={draft.validating}
              onPress={handleValidate}
            >
              {({ isPending }) => (
                <>
                  {isPending ? null : <Wifi size={12} />}
                  {t('llmCardValidate')}
                </>
              )}
            </Button>
            <div className="flex-1" />
            <Button variant="ghost" size="sm" onPress={onClose}>取消</Button>
            <Button
              size="sm"
              isPending={saving}
              isDisabled={errors.length > 0}
              onPress={handleSave}
            >
              {({ isPending }) => (
                <>
                  {isPending ? null : <Save size={12} />}
                  {t('llmCardSave')}
                </>
              )}
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  )
}
