import type { ReactNode } from 'react'
import { Compass, Plug, Settings2, Sparkles, Wrench } from 'lucide-react'
import { useExtensionCopy } from './extension-copy'
import type { ExtensionKind } from '../../../../lib/api/extensions'
import './extensions.css'
export type SettingsSection = 'general' | ExtensionKind | 'market'
export function SettingsFrame({
  section,
  onSelect,
  children,
  projectId,
  projectMode = false,
}: {
  section: SettingsSection
  onSelect: (section: SettingsSection) => void
  children: ReactNode
  projectId?: string | null
  projectMode?: boolean
}) {
  const copy = useExtensionCopy()
  return (
    <div className="extension-settings-layout">
      <nav className="extension-settings-nav" aria-label={copy.general}>
        <p className="extension-nav-title">{copy.settings}</p>
        <button
          type="button"
          className={section === 'general' ? 'is-selected' : ''}
          aria-current={section === 'general' ? 'page' : undefined}
          onClick={() => onSelect('general')}
        >
          <Settings2 size={16} />
          {projectMode ? copy.project : copy.general}
        </button>
        <p className="extension-nav-group">{copy.extensions}</p>
        {(
          [
            { id: 'tool', icon: Wrench },
            { id: 'skill', icon: Sparkles },
            { id: 'mcp', icon: Plug },
            { id: 'market', icon: Compass },
          ] as const
        ).map(({ id, icon: Icon }) => (
          <button
            key={id}
            type="button"
            className={section === id ? 'is-selected' : ''}
            aria-current={section === id ? 'page' : undefined}
            onClick={() => onSelect(id)}
          >
            <Icon size={16} />
            {copy[id]}
          </button>
        ))}
        {!projectId && (
          <p className="extension-project-hint">{copy.pickProject}</p>
        )}
      </nav>
      <main className="extension-settings-main">{children}</main>
    </div>
  )
}
