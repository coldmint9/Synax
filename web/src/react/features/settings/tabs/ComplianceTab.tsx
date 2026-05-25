import { useState, useCallback } from 'react'
import { Card, Checkbox, NumberField } from '@heroui/react'
import type { ProjectSettings, ComplianceSettings } from '../../../../lib/contracts/project-settings'
import { useLocale } from '../../../../hooks/useLocale'
import { SaveFooter } from '../components/SaveFooter'

interface ComplianceTabProps {
  settings: ProjectSettings
  onSave: (data: Partial<ComplianceSettings>) => Promise<ProjectSettings>
}

export function ComplianceTab({ settings, onSave }: ComplianceTabProps) {
  const { t } = useLocale()
  const [draft, setDraft] = useState<ComplianceSettings>({ ...settings.compliance })
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
        <Card.Content>
          <div className="grid gap-3 sm:grid-cols-2">
            <NumberField
              size="sm"
              variant="bordered"
              value={draft.retentionDays}
              onChange={(val) => setDraft(d => ({ ...d, retentionDays: val }))}
              minValue={1}
              maxValue={3650}
            >
              <label className="text-xs text-foreground">{t('complianceRetentionDays')}</label>
              <NumberField.Group>
                <NumberField.Input />
              </NumberField.Group>
            </NumberField>
          </div>
          <div className="mt-3 space-y-2">
            <Checkbox size="sm" isSelected={draft.auditLogEnabled} onChange={(isChecked) => setDraft(d => ({ ...d, auditLogEnabled: isChecked }))}>
              <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
              <Checkbox.Content>{t('complianceAuditLog')}</Checkbox.Content>
            </Checkbox>
            <Checkbox size="sm" isSelected={draft.dataExportAllowed} onChange={(isChecked) => setDraft(d => ({ ...d, dataExportAllowed: isChecked }))}>
              <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
              <Checkbox.Content>{t('complianceDataExport')}</Checkbox.Content>
            </Checkbox>
            <Checkbox size="sm" isSelected={draft.piiMasking} onChange={(isChecked) => setDraft(d => ({ ...d, piiMasking: isChecked }))}>
              <Checkbox.Control><Checkbox.Indicator /></Checkbox.Control>
              <Checkbox.Content>{t('compliancePiiMasking')}</Checkbox.Content>
            </Checkbox>
          </div>
        </Card.Content>
      </Card>

      <SaveFooter saving={saving} saved={saved} onSave={handleSave} />
    </div>
  )
}