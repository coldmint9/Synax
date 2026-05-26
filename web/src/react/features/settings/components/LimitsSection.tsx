import { useState, useCallback } from 'react'
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

  const handleChange = (field: string, raw: string) => {
    const value = parseInt(raw, 10)
    if (isNaN(value)) return
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
          <input
            type="number"
            className={`w-24 rounded-md border px-2 py-1 text-sm bg-transparent outline-none focus:ring-1 ${fieldError('maxAgentsPerProject') ? 'border-danger focus:ring-danger' : 'border-default-300 focus:ring-primary'}`}
            value={maxAgents}
            min={1}
            max={100}
            onChange={(e) => handleChange('maxAgentsPerProject', e.target.value)}
          />
        </FormRow>
        <FormRow label={t('settingsAgentTimeout')} description={t('settingsAgentTimeoutDesc')}>
          <input
            type="number"
            className={`w-24 rounded-md border px-2 py-1 text-sm bg-transparent outline-none focus:ring-1 ${fieldError('agentTimeoutSeconds') ? 'border-danger focus:ring-danger' : 'border-default-300 focus:ring-primary'}`}
            value={timeout}
            min={10}
            max={3600}
            onChange={(e) => handleChange('agentTimeoutSeconds', e.target.value)}
          />
        </FormRow>
      </div>
    </SettingsCard>
  )
}