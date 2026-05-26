import { useState } from 'react'
import { Button, Description, FieldError, Input, InputGroup, Label, Modal, TextField } from '@heroui/react'
import { Eye, EyeOff, RefreshCw, Save, Wifi } from 'lucide-react'
import { type ApiProviderDraft } from '../lib/providerPresets'
import { validateProviderDraft } from '../lib/validation'
import { useLocale } from '../../../../hooks/useLocale'
import { SettingsSelect } from './SettingsSelect'
import type { ApiFormat } from '../../../../lib/contracts/config'

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

  const errors = validateProviderDraft(draft)
  const fieldError = (field: string) => errors.find(e => e.field === field)?.message

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

              <div className="space-y-1">
                <div className="flex gap-1.5 items-end">
                  {draft.models.length > 1 ? (
                    <SettingsSelect
                      label={t('llmCardModel')}
                      className="flex-1"
                      selectedKey={draft.model}
                      onSelectionChange={(key) => {
                        if (key) setDraft(d => ({ ...d, model: key }))
                      }}
                      disallowEmptySelection
                      options={draft.models.map(m => ({ key: m, label: m }))}
                    />
                  ) : (
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
                  )}
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
