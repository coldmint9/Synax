import { useState, useCallback } from 'react'
import { Gauge } from 'lucide-react'
import { SettingsSection } from './SettingsSection'
import { SaveIndicator } from './SaveIndicator'
import { useAutoSave } from '../useAutoSave'
import { validateLimits, type FieldError } from '../lib/validation'
import type { GlobalConfig } from '../../../../lib/contracts/config'

interface LimitsSectionProps {
  config: GlobalConfig
  onUpdate: (patch: Record<string, unknown>) => Promise<void>
}

export function LimitsSection({ config, onUpdate }: LimitsSectionProps) {
  const [maxAgents, setMaxAgents] = useState(config.limits.maxAgentsPerProject)
  const [maxSessions, setMaxSessions] = useState(config.limits.maxSessionsPerUser)
  const [timeout, setTimeout_] = useState(Math.round(config.limits.agentTimeoutMs / 1000))
  const [errors, setErrors] = useState<FieldError[]>([])

  const saveFn = useCallback(async (limits: { maxAgentsPerProject: number; maxSessionsPerUser: number; agentTimeoutSeconds: number }) => {
    const errs = validateLimits(limits)
    setErrors(errs)
    if (errs.length > 0) throw new Error(errs[0].message)
    await onUpdate({
      limits: {
        maxAgentsPerProject: limits.maxAgentsPerProject,
        maxSessionsPerUser: limits.maxSessionsPerUser,
        agentTimeoutMs: limits.agentTimeoutSeconds * 1000,
      },
    })
  }, [onUpdate])

  const { save, saving, saved, error } = useAutoSave(saveFn, { debounceMs: 500 })

  const fieldError = (field: string) => errors.find(e => e.field === field)?.message

  const handleChange = (field: string, value: number) => {
    if (field === 'maxAgentsPerProject') setMaxAgents(value)
    else if (field === 'maxSessionsPerUser') setMaxSessions(value)
    else setTimeout_(value)
    const next = {
      maxAgentsPerProject: field === 'maxAgentsPerProject' ? value : maxAgents,
      maxSessionsPerUser: field === 'maxSessionsPerUser' ? value : maxSessions,
      agentTimeoutSeconds: field === 'agentTimeoutSeconds' ? value : timeout,
    }
    save(next)
  }

  return (
    <SettingsSection title="运行限制" icon={Gauge} trailing={<SaveIndicator saving={saving} saved={saved} error={error} />}>
      <div className="space-y-3">
        <NumberField label="单项目最大 Agent" desc="每个项目允许的最大并发 Agent 数" value={maxAgents} onChange={v => handleChange('maxAgentsPerProject', v)} error={fieldError('maxAgentsPerProject')} />
        <NumberField label="单用户最大会话" desc="每个用户允许的最大活跃会话数" value={maxSessions} onChange={v => handleChange('maxSessionsPerUser', v)} error={fieldError('maxSessionsPerUser')} />
        <NumberField label="Agent 超时 (秒)" desc="Agent 执行超时时间" value={timeout} onChange={v => handleChange('agentTimeoutSeconds', v)} error={fieldError('agentTimeoutSeconds')} />
      </div>
    </SettingsSection>
  )
}

function NumberField({ label, desc, value, onChange, error }: { label: string; desc: string; value: number; onChange: (v: number) => void; error?: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <div className="min-w-0">
        <div className="text-xs font-medium text-foreground">{label}</div>
        <div className="text-[11px] text-muted-foreground">{desc}</div>
        {error && <div className="text-[11px] text-destructive mt-0.5">{error}</div>}
      </div>
      <input
        type="number"
        className={`settings-number${error ? ' border-destructive' : ''}`}
        value={value}
        onChange={e => onChange(Number(e.target.value))}
      />
    </div>
  )
}
