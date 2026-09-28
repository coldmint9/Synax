import { Menu, MenuButton, MenuItems, MenuAction } from "@/react/components/ui/Menu";
import { Button } from "@/react/components/ui/Button";
import { Switch } from "@/react/components/ui/Toggle";
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
              checked={item.enabled}
              disabled={busy}
              onChange={onToggle}
              aria-label={`${copy.toggle}: ${item.name}`}
            />
            <Menu>
              <MenuButton className="size-7 text-muted-foreground hover:bg-muted" disabled={busy} aria-label={`${copy.more}: ${item.name}`}><MoreHorizontal size={16} /></MenuButton>
              <MenuItems aria-label={copy.more}>
                <MenuAction onClick={onOpen}>{copy.details}</MenuAction>
                {item.editable && <MenuAction onClick={onEdit}>{copy.edit}</MenuAction>}
                <MenuAction danger onClick={onUninstall}>{copy.uninstall}</MenuAction>
              </MenuItems>
            </Menu>
          </>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            disabled={busy || Boolean(item.conflict)}
            onClick={onInstall}
            aria-label={`${copy.install}: ${item.name}`}
          >
            {copy.install}
          </Button>
        )}
      </div>
    </li>
  )
}
