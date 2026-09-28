import { Menu, MenuButton, MenuItems, MenuAction } from "@/react/components/ui/Menu";
import { Switch } from "@/react/components/ui/Toggle";
import { MoreHorizontal } from 'lucide-react'
import { useLocale } from '../../../hooks/useLocale'

interface Action {
  id: string
  label: string
  onAction: () => void
  danger?: boolean
  disabled?: boolean
}

/** Installation is an explicit action; the switch only changes runtime enablement. */
export function ExtensionControls({
  name,
  enabled,
  busy,
  onToggle,
  actions = [],
}: {
  name: string
  enabled: boolean
  busy: boolean
  onToggle: (enabled: boolean) => void
  actions?: Action[]
}) {
  const { t } = useLocale()
  return (
    <div className="flex shrink-0 items-center gap-2">
      <span className="hidden text-xs text-muted-foreground sm:inline">
        {t(enabled ? 'extensionEnabled' : 'extensionDisabled')}
      </span>
      <Switch
        size="md"
        checked={enabled}
        disabled={busy}
        onChange={onToggle}
        aria-label={t('extensionToggle', { name })}
      />
      {actions.length > 0 ? (
        <Menu>
          <MenuButton className="size-7 text-muted-foreground hover:bg-muted" disabled={busy} aria-label={t('extensionActions', { name })}>
            <MoreHorizontal size={16} />
          </MenuButton>
          <MenuItems aria-label={t('extensionActions', { name })}>
            {actions.map(action => <MenuAction key={action.id} disabled={action.disabled} danger={action.danger} onClick={action.onAction}>{action.label}</MenuAction>)}
          </MenuItems>
        </Menu>
      ) : (
        <span aria-hidden="true" className="size-8" />
      )}
    </div>
  )
}
