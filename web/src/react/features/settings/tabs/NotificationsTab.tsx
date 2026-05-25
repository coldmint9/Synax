import { useState, useCallback } from 'react'
import { Button, Card, Chip, Input } from '@heroui/react'
import type { ProjectSettings, NotificationSettings } from '../../../../lib/contracts/project-settings'
import { useLocale } from '../../../../hooks/useLocale'
import { SettingsSelect } from '../components/SettingsSelect'
import { SaveFooter } from '../components/SaveFooter'

interface NotificationsTabProps {
  settings: ProjectSettings
  onSave: (data: Partial<NotificationSettings>) => Promise<ProjectSettings>
}

export function NotificationsTab({ settings, onSave }: NotificationsTabProps) {
  const { t } = useLocale()
  const [draft, setDraft] = useState<NotificationSettings>({ ...settings.notifications, recipients: [...settings.notifications.recipients] })
  const [saving, setSaving] = useState(false)
  const [saved, setSaved] = useState(false)
  const [recipientInput, setRecipientInput] = useState('')

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

  const addRecipient = () => {
    const r = recipientInput.trim()
    if (r && !draft.recipients.includes(r)) {
      setDraft(d => ({ ...d, recipients: [...d.recipients, r] }))
      setRecipientInput('')
    }
  }

  const removeRecipient = (r: string) => {
    setDraft(d => ({ ...d, recipients: d.recipients.filter(x => x !== r) }))
  }

  return (
    <div className="mt-4 space-y-4">
      <Card variant="secondary">
        <Card.Content>
          <div className="grid gap-3 sm:grid-cols-2">
            <SettingsSelect
              label={t('notifChannel')}
              selectedKeys={[draft.channel]}
              onSelectionChange={(keys) => {
                const val = [...keys][0] as string
                if (val) setDraft(d => ({ ...d, channel: val as NotificationSettings['channel'] }))
              }}
              disallowEmptySelection
              options={[
                { key: 'none', label: t('notifChannelNone') },
                { key: 'email', label: 'Email' },
                { key: 'im', label: 'IM' },
                { key: 'webhook', label: 'Webhook' },
              ]}
            />
            <SettingsSelect
              label={t('notifMinSeverity')}
              selectedKeys={[draft.minSeverity]}
              onSelectionChange={(keys) => {
                const val = [...keys][0] as string
                if (val) setDraft(d => ({ ...d, minSeverity: val as NotificationSettings['minSeverity'] }))
              }}
              disallowEmptySelection
              options={[
                { key: 'info', label: 'Info' },
                { key: 'warning', label: 'Warning' },
                { key: 'critical', label: 'Critical' },
              ]}
            />
            {draft.channel === 'webhook' && (
              <div className="sm:col-span-2">
                <Input
                  size="sm"
                  variant="bordered"
                  label="Webhook URL"
                  labelPlacement="outside"
                  value={draft.webhookUrl}
                  onValueChange={(val) => setDraft(d => ({ ...d, webhookUrl: val }))}
                  placeholder="https://..."
                />
              </div>
            )}
            <Input
              size="sm"
              variant="bordered"
              label={t('notifQuietHours')}
              labelPlacement="outside"
              value={draft.quietHours}
              onValueChange={(val) => setDraft(d => ({ ...d, quietHours: val }))}
              placeholder={t('notifQuietHoursPlaceholder')}
            />
          </div>
        </Card.Content>
      </Card>

      <Card variant="secondary">
        <Card.Header>
          <span className="text-xs font-semibold">{t('notifRecipients')}</span>
        </Card.Header>
        <Card.Content>
          <div className="flex flex-wrap gap-1.5 mb-2">
            {draft.recipients.map(r => (
              <Chip key={r} size="sm" variant="flat" onClose={() => removeRecipient(r)}>{r}</Chip>
            ))}
          </div>
          <div className="flex gap-2">
            <Input
              size="sm"
              variant="bordered"
              className="flex-1"
              value={recipientInput}
              onValueChange={setRecipientInput}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), addRecipient())}
              placeholder={t('notifAddRecipientPlaceholder')}
            />
            <Button size="sm" variant="bordered" onPress={addRecipient}>{t('commonAdd')}</Button>
          </div>
        </Card.Content>
      </Card>

      <SaveFooter saving={saving} saved={saved} onSave={handleSave} />
    </div>
  )
}