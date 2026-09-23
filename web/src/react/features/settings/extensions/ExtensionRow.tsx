import { Button, Dropdown, Switch } from '@heroui/react'
import { MoreHorizontal, Plug, Sparkles, Wrench } from 'lucide-react'
import type { ExtensionItem } from '../../../../lib/api/extensions'
import { useExtensionCopy } from './extension-copy'
export function ExtensionRow({
  item,
  market,
  busy,
  onOpen,
  onInstall,
  onToggle,
  onEdit,
  onUninstall,
}: {
  item: ExtensionItem
  market: boolean
  busy: boolean
  onOpen: () => void
  onInstall: () => void
  onToggle: (enabled: boolean) => void
  onEdit: () => void
  onUninstall: () => void
}) {
  const copy = useExtensionCopy()
  const Icon =
    item.kind === 'tool' ? Wrench : item.kind === 'skill' ? Sparkles : Plug
  const sourceLabel =
    item.sourceId === 'builtin'
      ? copy.builtin
      : item.sourceId === 'local'
        ? copy.local
        : item.sourceId === 'custom'
          ? copy.custom
          : item.sourceLabel
  return (
    <li className="extension-row">
      <button
        type="button"
        className="extension-row-open"
        onClick={onOpen}
        aria-label={`${copy.details}: ${item.name}`}
      >
        <span className="extension-row-icon">
          <Icon size={17} strokeWidth={1.6} />
        </span>
        <span className="extension-row-copy">
          <span className="extension-row-title">
            <strong>{item.name}</strong>
            {market && <small>{copy[item.kind]}</small>}
            {item.version && <small>{item.version}</small>}
          </span>
          <span className="extension-row-description" title={item.description}>
            {item.description}
          </span>
          {market && (
            <span className="extension-row-source">{sourceLabel}</span>
          )}
        </span>
      </button>
      <div className="extension-row-actions">
        {item.installed ? (
          <>
            <span className="extension-row-state">
              {item.enabled ? copy.enabled : copy.disabled}
            </span>
            <Switch
              size="md"
              isSelected={item.enabled}
              isDisabled={busy}
              onChange={onToggle}
              aria-label={`${copy.toggle}: ${item.name}`}
            >
              <Switch.Content>
                <Switch.Control>
                  <Switch.Thumb />
                </Switch.Control>
              </Switch.Content>
            </Switch>
            <Dropdown>
              <Button
                size="sm"
                variant="ghost"
                isIconOnly
                isDisabled={busy}
                aria-label={`${copy.more}: ${item.name}`}
              >
                <MoreHorizontal size={16} />
              </Button>
              <Dropdown.Popover placement="bottom end">
                <Dropdown.Menu
                  aria-label={copy.more}
                  onAction={(key) =>
                    key === 'edit'
                      ? onEdit()
                      : key === 'remove'
                        ? onUninstall()
                        : onOpen()
                  }
                >
                  <Dropdown.Item id="details" textValue={copy.details}>
                    {copy.details}
                  </Dropdown.Item>
                  {item.editable && (
                    <Dropdown.Item id="edit" textValue={copy.edit}>
                      {copy.edit}
                    </Dropdown.Item>
                  )}
                  <Dropdown.Item
                    id="remove"
                    textValue={copy.uninstall}
                    className="text-danger"
                  >
                    {copy.uninstall}
                  </Dropdown.Item>
                </Dropdown.Menu>
              </Dropdown.Popover>
            </Dropdown>
          </>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            isDisabled={busy || Boolean(item.conflict)}
            onPress={onInstall}
            aria-label={`${copy.install}: ${item.name}`}
          >
            {copy.install}
          </Button>
        )}
      </div>
    </li>
  )
}
