import { useState, useCallback } from 'react'
import { Card, Checkbox, NumberField } from '@heroui/react'
import type { ProjectSettings, CollaborationSettings } from '../../../../lib/contracts/project-settings'
import { useLocale } from '../../../../hooks/useLocale'
import { SaveFooter } from '../components/SaveFooter'

interface CollaborationTabProps {
  settings: ProjectSettings
  onSave: (data: Partial<CollaborationSettings>) => Promise<ProjectSettings>
}

export function CollaborationTab({ settings, onSave }: CollaborationTabProps) {
  const { t } = useLocale()
  const [draft, setDraft] = useState<CollaborationSettings>({ ...settings.collaboration, reviewPolicy: { ...settings.collaboration.reviewPolicy } })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)

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

  return (
    <div className="mt-4 space-y-4">
      <Card variant="secondary">
        <Card.Header>
          <span className="text-xs font-semibold">{t('collabAgentPermissions')}</span>
        </Card.Header>
        <Card.Content>
          <Checkbox size="sm" isSelected={draft.agentsAllowDirectCommit} onChange={(isChecked) => setDraft(d => ({ ...d, agentsAllowDirectCommit: isChecked }))}>
            <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
            <Checkbox.Content>{t('collabAllowDirectCommit')}</Checkbox.Content>
          </Checkbox>
        </Card.Content>
      </Card>

      <Card variant="secondary">
        <Card.Header>
          <span className="text-xs font-semibold">{t('collabReviewPolicy')}</span>
        </Card.Header>
        <Card.Content>
          <div className="grid gap-3 sm:grid-cols-2">
            <NumberField
              size="sm"
              variant="bordered"
              value={draft.reviewPolicy.minApprovals}
              onChange={(val) => setDraft(d => ({ ...d, reviewPolicy: { ...d.reviewPolicy, minApprovals: val } }))}
              minValue={0}
              maxValue={5}
            >
              <label className="text-xs text-foreground">{t('collabMinApprovals')}</label>
              <NumberField.Group>
                <NumberField.Input />
              </NumberField.Group>
            </NumberField>
          </div>
          <div className="mt-3 space-y-2">
            <Checkbox size="sm" isSelected={draft.reviewPolicy.requireQaApproval} onChange={(isChecked) => setDraft(d => ({ ...d, reviewPolicy: { ...d.reviewPolicy, requireQaApproval: isChecked } }))}>
              <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
              <Checkbox.Content>{t('collabRequireQa')}</Checkbox.Content>
            </Checkbox>
            <Checkbox size="sm" isSelected={draft.reviewPolicy.requireOwnerApproval} onChange={(isChecked) => setDraft(d => ({ ...d, reviewPolicy: { ...d.reviewPolicy, requireOwnerApproval: isChecked } }))}>
              <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
              <Checkbox.Content>{t('collabRequireOwner')}</Checkbox.Content>
            </Checkbox>
            <Checkbox size="sm" isSelected={draft.reviewPolicy.blockOnFailedCi} onChange={(isChecked) => setDraft(d => ({ ...d, reviewPolicy: { ...d.reviewPolicy, blockOnFailedCi: isChecked } }))}>
              <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
              <Checkbox.Content>{t('collabBlockOnCi')}</Checkbox.Content>
            </Checkbox>
          </div>
        </Card.Content>
      </Card>

      <SaveFooter saving={saving} saved={saved} onSave={handleSave} />
    </div>
  )
}