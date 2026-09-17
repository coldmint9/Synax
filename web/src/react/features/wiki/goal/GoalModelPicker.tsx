import { useMemo, useState } from 'react'
import { Popover, useOverlayState } from '@heroui/react'
import type { GlobalConfig, ProviderDef } from '../../../../lib/contracts/config'
import { useLocale } from '../../../../hooks/useLocale'
import {
  buildGoalModelOptions,
  findGoalModelSelection,
  selectionKey,
  type GoalModelSelection,
} from './goalModelOptions'
import { useAcpDiscovery } from './useAcpDiscovery'

/** Above this many options the list gets a search field. */
const LARGE_LIST_THRESHOLD = 40

interface Props {
  backendId?: string
  globalConfig: GlobalConfig | null
  providers: ProviderDef[]
  providerId: string | null
  modelId: string | null
  onSelect: (selection: GoalModelSelection) => void
  disabled?: boolean
  onOverlayOpenChange?: (open: boolean) => void
}

function matchesQuery(option: GoalModelSelection, query: string, providerLabel: string): boolean {
  if (!query) return true
  return option.label.toLowerCase().includes(query) || providerLabel.toLowerCase().includes(query)
}

/** Provider names live in group headings; each option only displays its model. */
function ModelOption({
  option,
  selected,
  onPick,
}: {
  option: GoalModelSelection
  selected: boolean
  onPick: () => void
}) {
  return (
    <button
      type="button"
      role="option"
      aria-selected={selected}
      onClick={onPick}
      className={`flex w-full items-center gap-2 rounded-item px-2.5 py-1.5 text-left transition-colors ${
        selected
          ? 'bg-primary/10 text-primary'
          : 'text-foreground/80 hover:bg-secondary/60'
      }`}
    >
      <span className="min-w-0 flex-1 truncate text-[11px] font-medium">{option.label}</span>
    </button>
  )
}

export function GoalModelPicker({
  backendId,
  globalConfig,
  providers,
  providerId,
  modelId,
  onSelect,
  disabled,
  onOverlayOpenChange,
}: Props) {
  const { t } = useLocale()
  const state = useOverlayState({
    onOpenChange: onOverlayOpenChange,
  })
  const [searchQuery, setSearchQuery] = useState('')
  // Only probe ACP when the picker opens — keep session select off the critical path.
  const acpDiscovery = useAcpDiscovery({ enabled: state.isOpen })

  const { apiModels, acpEndpoints } = useMemo(
    () => {
      const options = buildGoalModelOptions(globalConfig, providers, acpDiscovery)
      if (!backendId) return options
      return { apiModels: backendId === 'native' ? options.apiModels : [],
        acpEndpoints: options.acpEndpoints.filter(option => option.providerId === backendId) }
    },
    [globalConfig, providers, acpDiscovery, backendId],
  )

  const allOptions = useMemo(() => [...apiModels, ...acpEndpoints], [apiModels, acpEndpoints])
  const showSearch = allOptions.length > LARGE_LIST_THRESHOLD

  const selected = useMemo(
    () => findGoalModelSelection(apiModels, acpEndpoints, providerId, modelId),
    [apiModels, acpEndpoints, providerId, modelId],
  )

  const currentKey = selected ? selectionKey(selected) : null
  const selectedProviderLabel = providerId
    ? providers.find(provider => provider.id === providerId)?.label ?? providerId
    : null
  const selectedModelLabel = selected?.label ?? modelId
  const triggerLabel = selectedProviderLabel && selectedModelLabel
    ? `${selectedProviderLabel} · ${selectedModelLabel}`
    : selectedModelLabel ?? t('goalModelSelect')

  const query = searchQuery.trim().toLowerCase()
  const groups = useMemo(() => {
    const labels = new Map(providers.map(provider => [provider.id, provider.label]))
    const grouped = new Map<string, { label: string; options: GoalModelSelection[] }>()
    for (const option of allOptions) {
      const label = labels.get(option.providerId) || option.providerId
      if (!matchesQuery(option, query, label)) continue
      let group = grouped.get(option.providerId)
      if (!group) {
        group = { label, options: [] }
        grouped.set(option.providerId, group)
      }
      group.options.push(option)
    }
    return Array.from(grouped, ([id, group]) => ({ id, ...group }))
  }, [allOptions, providers, query])

  function handlePick(option: GoalModelSelection) {
    onSelect(option)
    setSearchQuery('')
    state.close()
  }

  const triggerDisabled = Boolean(disabled)

  return (
    <Popover
      isOpen={triggerDisabled ? false : state.isOpen}
      onOpenChange={(open) => {
        if (triggerDisabled) return
        state.setOpen(open)
        if (!open) setSearchQuery('')
      }}
    >
      <Popover.Trigger
        aria-label={t('goalModelSelect')}
        aria-disabled={triggerDisabled}
        title={triggerLabel}
        className={`button button--sm button--tertiary goal-dock-composer-chip goal-model-picker-trigger inline-flex h-7 max-w-[18rem] shrink-0 items-center rounded-full px-2.5 text-[11px] font-normal text-muted-foreground${triggerDisabled ? ' pointer-events-none opacity-50' : ''}`}
      >
        <span className="truncate">{triggerLabel}</span>
      </Popover.Trigger>
      <Popover.Content placement="top end" offset={8} className="z-50 w-[20rem] overflow-hidden p-0">
        {showSearch && (
          <div className="border-b border-border/30 p-1.5">
            <input
              autoFocus
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder={t('goalModelSearch')}
              className="h-7 w-full rounded-item bg-muted/40 px-2 text-[11px] outline-none placeholder:text-muted-foreground/50"
            />
          </div>
        )}
        <div
          role="listbox"
          aria-label={t('goalModelSelect')}
          className="max-h-64 overflow-y-auto p-1.5"
        >
          {groups.map(group => (
            <div key={group.id} role="group" aria-label={group.label} className="mb-1 last:mb-0">
              <div className="px-2.5 pb-1 pt-2 text-[10px] font-medium text-muted-foreground">
                {group.label}
              </div>
              {group.options.map(option => (
                <ModelOption
                  key={selectionKey(option)}
                  option={option}
                  selected={currentKey === selectionKey(option)}
                  onPick={() => handlePick(option)}
                />
              ))}
            </div>
          ))}
          {groups.length === 0 && (
            <p className="px-2 py-3 text-center text-[10px] text-muted-foreground/50">
              {query ? t('goalModelNoMatch') : t('goalModelEmpty')}
            </p>
          )}
        </div>
      </Popover.Content>
    </Popover>
  )
}
