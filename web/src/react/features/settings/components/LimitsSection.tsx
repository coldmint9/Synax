import { useState, useCallback } from 'react'
import { NumberField, Label } from '@heroui/react'
import { Gauge } from 'lucide-react'
import { SettingsCard } from './SettingsCard'
import { FormRow } from './FormRow'
import { SaveIndicator } from './SaveIndicator'
import { useAutoSave } from '../useAutoSave'
import { validateLimits, type FieldError } from '../lib/validation'
import type { GlobalConfig } from '../../../../lib/contracts/config'
import { useLocale } from '../../../../hooks/useLocale'

interface LimitsSectionProps {
  config: GlobalConfig
  onUpdate: (patch: Record<string, unknown>) => Promise<void>
}

export function LimitsSection({ config, onUpdate }: LimitsSectionProps) {
  const { t } = useLocale()
  const [maxAgents, setMaxAgents] = useState(config.limits.maxAgentsPerProject)
  const [timeout, setTimeout_] = useState(Math.round(config.limits.agentTimeoutMs / 1000))
  const [errors, setErrors] = useState<FieldError[]>([])

  const saveFn = useCallback(async (limits: { maxAgentsPerProject: number; agentTimeoutSeconds: number }) => {
    const errs = validateLimits(limits)
    setErrors(errs)
    if (errs.length > 0) throw new Error(errs[0].message)
    await onUpdate({
      limits: {
        maxAgentsPerProject: limits.maxAgentsPerProject,
        agentTimeoutMs: limits.agentTimeoutSeconds * 1000,
      },
    })
  }, [onUpdate])

  const { save, saving, saved, error } = useAutoSave(saveFn, { debounceMs: 500 })

  const fieldError = (field: string) => errors.find(e => e.field === field)?.message

  const handleChange = (field: string, value: number) => {
    if (field === 'maxAgentsPerProject') setMaxAgents(value)
    else setTimeout_(value)
    const next = {
      maxAgentsPerProject: field === 'maxAgentsPerProject' ? value : maxAgents,
      agentTimeoutSeconds: field === 'agentTimeoutSeconds' ? value : timeout,
    }
    save(next)
  }

  return (
    <SettingsCard title={t('settingsLimitsTitle')} icon={Gauge} trailing={<SaveIndicator saving={saving} saved={saved} error={error} />}>
      <div className="space-y-3">
        <FormRow label={t('settingsMaxAgents')} description={t('settingsMaxAgentsDesc')}>
          <NumberField
            size="sm"
            variant="bordered"
            className="w-24"
            fullWidth={false}
            value={maxAgents}
            onChange={(val) => handleChange('maxAgentsPerProject', val)}
            minValue={1}
            maxValue={100}
            isInvalid={!!fieldError('maxAgentsPerProject')}
          >
            <NumberField.Group>
              <NumberField.Input />
            </NumberField.Group>
          </NumberField>
        </FormRow>
        <FormRow label={t('settingsAgentTimeout')} description={t('settingsAgentTimeoutDesc')}>
          <NumberField
            size="sm"
            variant="bordered"
            className="w-24"
            fullWidth={false}
            value={timeout}
            onChange={(val) => handleChange('agentTimeoutSeconds', val)}
            minValue={10}
            maxValue={3600}
            isInvalid={!!fieldError('agentTimeoutSeconds')}
          >
            <NumberField.Group>
              <NumberField.Input />
            </NumberField.Group>
          </NumberField>
        </FormRow>
      </div>
    </SettingsCard>
  )
}