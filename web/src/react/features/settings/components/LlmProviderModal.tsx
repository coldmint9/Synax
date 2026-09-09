import { useState } from 'react'
import { Button, Checkbox, Description, FieldError, InputGroup, Label, Modal, TextField } from '@heroui/react'
import { ChevronDown, Eye, EyeOff, RefreshCw, Save, Search, Wifi } from 'lucide-react'
import { ALL_REASONING_EFFORTS, REASONING_EFFORT_LABELS, type ApiProviderDraft } from '../lib/providerPresets'
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
  const showModelDropdown = draft.models.length > 1
  const filteredModels = modelQuery.trim()
    ? draft.models.filter(m => m.toLowerCase().includes(modelQuery.trim().toLowerCase()))
    : draft.models

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
        setDraft(d => ({
          ...d,
          discoveringModels: false,
          models,
          model: models.includes(d.model) ? d.model : models[0],
          modelMessage: `发现 ${models.length} 个模型`,
        }))
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

  function selectModel(model: string) {
    setDraft(d => ({ ...d, model }))
    setModelMenuOpen(false)
    setModelQuery('')
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

              {draft.custom && (
                <SettingsSelect
                  label="API Format"
                  selectedKey={draft.format}
                  onSelectionChange={(key) => {
                    if (key) setDraft(d => ({ ...d, format: key as ApiFormat }))
                  }}
                  disallowEmptySelection
                  options={[
                    { key: 'openai', label: 'OpenAI Chat Completions' },
                    { key: 'openai-responses', label: 'OpenAI Responses' },
                    { key: 'anthropic', label: 'Anthropic Messages' },
                  ]}
                />
              )}

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

              {showModelDropdown ? (
                <div className="space-y-1">
                  <span className="block text-xs text-foreground pb-1">{t('llmCardModel')}</span>
                  <div className="flex gap-1.5 items-end">
                    <div className="relative flex-1">
                      <button
                        type="button"
                        onClick={() => setModelMenuOpen(o => !o)}
                        className="flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-default bg-transparent px-2.5 text-xs text-foreground transition-colors hover:bg-muted/40"
                      >
                        <span className="truncate font-mono">{draft.model || '选择模型…'}</span>
                        <ChevronDown size={13} className="shrink-0 text-muted-foreground" />
                      </button>
                      {modelMenuOpen && (
                        <div className="mt-1 w-full overflow-hidden rounded-lg border border-default bg-background shadow-lg">
                          <div className="flex items-center gap-1.5 border-b border-border/40 px-2">
                            <Search size={12} className="shrink-0 text-muted-foreground" />
                            <input
                              autoFocus
                              value={modelQuery}
                              onChange={(e) => setModelQuery(e.target.value)}
                              placeholder="搜索模型…"
                              className="h-8 w-full bg-transparent text-xs outline-none placeholder:text-muted-foreground/50"
                            />
                          </div>
                          <ul className="max-h-52 space-y-0.5 overflow-y-auto p-1.5">
                            {filteredModels.map(m => (
                              <li key={m}>
                                <button
                                  type="button"
                                  onClick={() => selectModel(m)}
                                  className={`flex w-full items-center justify-between gap-2 rounded-full px-3 py-1.5 text-left text-[11px] transition-colors ${
                                    m === draft.model
                                      ? 'bg-primary/10 font-medium text-primary'
                                      : 'text-foreground/85 hover:bg-muted/60'
                                  }`}
                                >
                                  <span className="truncate font-mono">{m}</span>
                                  {draft.modelMeta?.[m]?.contextLimit === 1_000_000 && (
                                    <span className="shrink-0 rounded-full bg-primary/10 px-1.5 py-px text-[9px] font-medium text-primary">1M</span>
                                  )}
                                </button>
                              </li>
                            ))}
                            {filteredModels.length === 0 && (
                              <li className="px-2.5 py-2 text-center text-[10px] text-muted-foreground/60">无匹配模型</li>
                            )}
                          </ul>
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
                  {draft.modelMessage && (
                    <div className="text-[10px] text-muted-foreground">{draft.modelMessage}</div>
                  )}
                </div>
              ) : (
                <div className="space-y-1">
                  <div className="flex gap-1.5 items-end">
                    <TextField
                      className="flex-1"
                      isInvalid={!!fieldError('model')}
                      value={draft.model}
                      onChange={(val) => setDraft(d => ({ ...d, model: val }))}
                    >
                      <Label className="text-xs">{t('llmCardModel')}</Label>
                      <InputGroup>
                        <InputGroup.Input />
                      </InputGroup>
                      {fieldError('model') && <FieldError>{fieldError('model')}</FieldError>}
                    </TextField>
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
                  {draft.modelMessage && (
                    <div className="text-[10px] text-muted-foreground">{draft.modelMessage}</div>
                  )}
                </div>
              )}

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
