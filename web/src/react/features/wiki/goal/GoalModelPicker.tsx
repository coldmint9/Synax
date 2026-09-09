import { useMemo, useState, type ReactNode } from 'react'
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

const LARGE_LIST_THRESHOLD = 40

interface Props {
  globalConfig: GlobalConfig | null
  providers: ProviderDef[]
  providerId: string | null
  modelId: string | null
  onSelect: (selection: GoalModelSelection) => void
  disabled?: boolean
  onOverlayOpenChange?: (open: boolean) => void
}

function OptionButton({
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
      onClick={onPick}
      className={`mx-0.5 mb-0.5 flex w-[calc(100%-4px)] flex-col items-start rounded-full px-3 py-1.5 text-left transition-colors ${
        selected
          ? 'bg-primary/10 text-primary'
          : 'text-foreground/80 hover:bg-secondary/60'
      }`}
    >
      <span className="w-full truncate text-[11px] font-medium">{option.label}</span>
      {(option.kind === 'api' || option.kind === 'acp') && (
        <span className="w-full truncate text-[9px] text-muted-foreground/60">{option.providerId}</span>
      )}
    </button>
  )
}

function ModelColumn({
  title,
  emptyLabel,
  isEmpty,
  children,
}: {
  title: string
  emptyLabel: string
  isEmpty: boolean
  children: ReactNode
}) {
  return (
    <div className="flex min-h-0 flex-col overflow-hidden">
      <div className="shrink-0 border-b border-border/20 px-2.5 py-1.5 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground/70">
        {title}
      </div>
      <div className="min-h-0 flex-1 overflow-y-auto p-1">
        {isEmpty ? (
          <p className="px-2 py-3 text-center text-[10px] text-muted-foreground/50">{emptyLabel}</p>
        ) : children}
      </div>
    </div>
  )
}

function GroupedModelList({
  options,
  selectedKey,
  providerLabel,
  onPick,
}: {
  options: GoalModelSelection[]
  selectedKey: string | null
  providerLabel: (providerId: string) => string
  onPick: (option: GoalModelSelection) => void
}) {
  const groups = useMemo(() => {
    const byProvider = new Map<string, GoalModelSelection[]>()
    for (const option of options) {
      const list = byProvider.get(option.providerId) ?? []
      list.push(option)
      byProvider.set(option.providerId, list)
    }
    return Array.from(byProvider.entries())
      .map(([providerId, items]) => ({
        providerId,
        label: providerLabel(providerId),
        items: items.sort((a, b) => a.label.localeCompare(b.label)),
      }))
      .sort((a, b) => a.label.localeCompare(b.label))
  }, [options, providerLabel])

  if (options.length === 0) {
    return <p className="px-2.5 py-3 text-center text-[10px] text-muted-foreground/50">无匹配模型</p>
  }

  return (
    <div className="max-h-64 space-y-1 overflow-y-auto p-1.5">
      {groups.map(group => (
        <div key={group.providerId}>
          <div className="sticky top-0 z-10 border-b border-border/20 bg-background px-2.5 py-1 text-[9px] font-semibold uppercase tracking-wide text-muted-foreground/60">
            {group.label}
          </div>
          {group.items.map(option => (
            <OptionButton
              key={selectionKey(option)}
              option={option}
              selected={selectedKey === selectionKey(option)}
              onPick={() => onPick(option)}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

export function GoalModelPicker({
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
    () => buildGoalModelOptions(globalConfig, providers, acpDiscovery),
    [globalConfig, providers, acpDiscovery],
  )

  const allOptions = useMemo(() => [...apiModels, ...acpEndpoints], [apiModels, acpEndpoints])
  const largeList = allOptions.length > LARGE_LIST_THRESHOLD

  const selected = useMemo(
    () => findGoalModelSelection(apiModels, acpEndpoints, providerId, modelId),
    [apiModels, acpEndpoints, providerId, modelId],
  )

  const currentKey = selected ? selectionKey(selected) : null
  const triggerLabel = selected?.label ?? modelId ?? t('goalModelSelect')

  const providerLabel = useMemo(() => {
    const map = new Map(providers.map(p => [p.id, p.label]))
    return (providerId: string) => map.get(providerId) ?? providerId
  }, [providers])

  const filteredOptions = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return allOptions
    return allOptions.filter(
      option =>
        option.label.toLowerCase().includes(q)
        || option.providerId.toLowerCase().includes(q),
    )
  }, [allOptions, searchQuery])

  const filteredApi = useMemo(() => filteredOptions.filter(o => o.kind === 'api'), [filteredOptions])
  const filteredAcp = useMemo(() => filteredOptions.filter(o => o.kind === 'acp'), [filteredOptions])

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
        className={`button button--sm button--tertiary goal-dock-composer-chip inline-flex h-7 max-w-[9.5rem] shrink-0 items-center rounded-full px-2.5 text-[11px] font-normal text-muted-foreground${triggerDisabled ? ' pointer-events-none opacity-50' : ''}`}
      >
        <span className="truncate">{triggerLabel}</span>
        <span className="ml-0.5 text-[8px] opacity-60">▾</span>
      </Popover.Trigger>
      <Popover.Content placement="top end" offset={8} className="z-50 w-[22rem] p-0 overflow-hidden">
        {largeList ? (
          <div className="flex flex-col">
            <div className="shrink-0 border-b border-border/20 p-1.5">
              <input
                autoFocus
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                placeholder="搜索模型 / 供应商…"
                className="h-7 w-full rounded-md bg-muted/40 px-2 text-[11px] outline-none placeholder:text-muted-foreground/50"
              />
            </div>
            <GroupedModelList
              options={filteredOptions}
              selectedKey={currentKey}
              providerLabel={providerLabel}
              onPick={handlePick}
            />
          </div>
        ) : (
          <div className="grid max-h-56 grid-cols-2 divide-x divide-border/25">
            <ModelColumn title={t('goalModelApi')} emptyLabel={t('goalModelApiEmpty')} isEmpty={filteredApi.length === 0}>
              {filteredApi.map(option => (
                <OptionButton
                  key={selectionKey(option)}
                  option={option}
                  selected={currentKey === selectionKey(option)}
                  onPick={() => handlePick(option)}
                />
              ))}
            </ModelColumn>
            <ModelColumn title={t('goalModelAcp')} emptyLabel={t('goalModelAcpEmpty')} isEmpty={filteredAcp.length === 0}>
              {filteredAcp.map(option => (
                <OptionButton
                  key={selectionKey(option)}
                  option={option}
                  selected={currentKey === selectionKey(option)}
                  onPick={() => handlePick(option)}
                />
              ))}
            </ModelColumn>
          </div>
        )}
      </Popover.Content>
    </Popover>
  )
}
