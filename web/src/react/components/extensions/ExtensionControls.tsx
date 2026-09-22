import { Button, Dropdown, Switch } from '@heroui/react'
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
        isSelected={enabled}
        isDisabled={busy}
        onChange={onToggle}
        aria-label={t('extensionToggle', { name })}
      >
        <Switch.Content>
          <Switch.Control>
            <Switch.Thumb />
          </Switch.Control>
        </Switch.Content>
      </Switch>
      {actions.length > 0 ? (
        <Dropdown>
          <Button
            size="sm"
            variant="ghost"
            isIconOnly
            isDisabled={busy}
            aria-label={t('extensionActions', { name })}
          >
            <MoreHorizontal size={16} />
          </Button>
          <Dropdown.Popover placement="bottom end">
            <Dropdown.Menu
              aria-label={t('extensionActions', { name })}
              onAction={(key) =>
                actions.find((action) => action.id === key)?.onAction()
              }
            >
              {actions.map((action) => (
                <Dropdown.Item
                  key={action.id}
                  id={action.id}
                  textValue={action.label}
                  isDisabled={action.disabled}
                  className={action.danger ? 'text-danger' : undefined}
                >
                  {action.label}
                </Dropdown.Item>
              ))}
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>
      ) : (
        <span aria-hidden="true" className="size-8" />
      )}
    </div>
  )
}
