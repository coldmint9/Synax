import { useMemo, type ReactNode } from 'react'
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
      className={`flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left transition-colors ${
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
  const acpDiscovery = useAcpDiscovery()
  const state = useOverlayState({
    onOpenChange: onOverlayOpenChange,
  })

  const { apiModels, acpEndpoints } = useMemo(
    () => buildGoalModelOptions(globalConfig, providers, acpDiscovery),
    [globalConfig, providers, acpDiscovery],
  )

  const selected = useMemo(
    () => findGoalModelSelection(apiModels, acpEndpoints, providerId, modelId),
    [apiModels, acpEndpoints, providerId, modelId],
  )

  const isEmpty = apiModels.length === 0 && acpEndpoints.length === 0
  const currentKey = selected ? selectionKey(selected) : null

  function handlePick(option: GoalModelSelection) {
    onSelect(option)
    state.close()
  }

  const triggerDisabled = Boolean(disabled || isEmpty)

  return (
    <Popover
      isOpen={triggerDisabled ? false : state.isOpen}
      onOpenChange={(open) => {
        if (triggerDisabled) return
        state.setOpen(open)
      }}
    >
      <Popover.Trigger
        aria-label={t('goalModelSelect')}
        aria-disabled={triggerDisabled}
        className={`button button--sm button--tertiary goal-dock-composer-chip inline-flex h-7 max-w-[9.5rem] shrink-0 items-center rounded-full px-2.5 text-[11px] font-normal text-muted-foreground${triggerDisabled ? ' pointer-events-none opacity-50' : ''}`}
      >
        <span className="truncate">{selected?.label ?? t('goalModelSelect')}</span>
        <span className="ml-0.5 text-[8px] opacity-60">▾</span>
      </Popover.Trigger>
      <Popover.Content placement="top end" offset={8} className="z-50 w-[22rem] p-0 overflow-hidden">
        <div className="grid max-h-56 grid-cols-2 divide-x divide-border/25">
          <ModelColumn title={t('goalModelApi')} emptyLabel={t('goalModelApiEmpty')} isEmpty={apiModels.length === 0}>
            {apiModels.map(option => (
              <OptionButton
                key={selectionKey(option)}
                option={option}
                selected={currentKey === selectionKey(option)}
                onPick={() => handlePick(option)}
              />
            ))}
          </ModelColumn>
          <ModelColumn title={t('goalModelAcp')} emptyLabel={t('goalModelAcpEmpty')} isEmpty={acpEndpoints.length === 0}>
            {acpEndpoints.map(option => (
              <OptionButton
                key={selectionKey(option)}
                option={option}
                selected={currentKey === selectionKey(option)}
                onPick={() => handlePick(option)}
              />
            ))}
          </ModelColumn>
        </div>
      </Popover.Content>
    </Popover>
  )
}
