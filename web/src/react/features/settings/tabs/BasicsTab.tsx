import { useState, useCallback } from 'react'
import { Button, Card, Chip, Input, TextArea } from '@heroui/react'
import type { ProjectSettings, ProjectBasics } from '../../../../lib/contracts/project-settings'
import { useLocale } from '../../../../hooks/useLocale'
import { SettingsSelect } from '../components/SettingsSelect'
import { SaveFooter } from '../components/SaveFooter'

interface BasicsTabProps {
  settings: ProjectSettings
  onSave: (data: Partial<ProjectBasics>) => Promise<ProjectSettings>
}

export function BasicsTab({ settings, onSave }: BasicsTabProps) {
  const { t } = useLocale()
  const [draft, setDraft] = useState<ProjectBasics>({ ...settings.basics })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [tagInput, setTagInput] = useState('')

  const handleSave = useCallback(async () => {
    setSaving(true)
    try {
      await onSave(draft)
      setSaved(true)
      setTimeout(() => setSaved(false), 1800)
    } finally {
      setSaving(false)
    }
  }, [draft, onSave])

  const addTag = () => {
    const tag = tagInput.trim()
    if (tag && !draft.tags.includes(tag)) {
      setDraft(d => ({ ...d, tags: [...d.tags, tag] }))
      setTagInput('')
    }
  }

  const removeTag = (tag: string) => {
    setDraft(d => ({ ...d, tags: d.tags.filter(t => t !== tag) }))
  }

  return (
    <div className="mt-4 space-y-4">
      <Card variant="secondary">
        <Card.Content>
          <div className="grid gap-3 sm:grid-cols-2">
            <Input
              size="sm"
              variant="bordered"
              label={t('basicsProjectName')}
              labelPlacement="outside"
              value={draft.name}
              onValueChange={(val) => setDraft(d => ({ ...d, name: val }))}
            />
            <SettingsSelect
              label={t('basicsEnvironment')}
              selectedKeys={[draft.environment]}
              onSelectionChange={(keys) => {
                const val = [...keys][0] as string
                if (val) setDraft(d => ({ ...d, environment: val as ProjectBasics['environment'] }))
              }}
              disallowEmptySelection
              options={[
                { key: 'development', label: 'Development' },
                { key: 'staging', label: 'Staging' },
                { key: 'production', label: 'Production' },
              ]}
            />
            <div className="sm:col-span-2">
              <TextArea
                size="sm"
                variant="bordered"
                label={t('basicsDescription')}
                labelPlacement="outside"
                value={draft.description}
                onChange={(e) => setDraft(d => ({ ...d, description: e.target.value }))}
                placeholder={t('basicsDescriptionPlaceholder')}
                rows={3}
              />
            </div>
            <SettingsSelect
              label={t('basicsVisibility')}
              selectedKeys={[draft.visibility]}
              onSelectionChange={(keys) => {
                const val = [...keys][0] as string
                if (val) setDraft(d => ({ ...d, visibility: val as ProjectBasics['visibility'] }))
              }}
              disallowEmptySelection
              options={[
                { key: 'private', label: 'Private' },
                { key: 'internal', label: 'Internal' },
                { key: 'public', label: 'Public' },
              ]}
            />
            <Input
              size="sm"
              variant="bordered"
              label={t('basicsOwner')}
              labelPlacement="outside"
              value={draft.ownerMemberId}
              onValueChange={(val) => setDraft(d => ({ ...d, ownerMemberId: val }))}
              placeholder={t('basicsMemberId')}
            />
          </div>
        </Card.Content>
      </Card>

      <Card variant="secondary">
        <Card.Header>
          <span className="text-xs font-semibold">{t('basicsTags')}</span>
        </Card.Header>
        <Card.Content>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {draft.tags.map(tag => (
              <Chip key={tag} size="sm" variant="flat" onClose={() => removeTag(tag)}>{tag}</Chip>
            ))}
          </div>
          <div className="flex gap-2">
            <Input
              size="sm"
              variant="bordered"
              className="flex-1"
              value={tagInput}
              onValueChange={setTagInput}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addTag())}
              placeholder={t('basicsAddTagPlaceholder')}
            />
            <Button size="sm" variant="bordered" onPress={addTag}>{t('commonAdd')}</Button>
          </div>
        </Card.Content>
      </Card>

      <SaveFooter saving={saving} saved={saved} onSave={handleSave} />
    </div>
  )
}