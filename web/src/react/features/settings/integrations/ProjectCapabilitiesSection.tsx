import { useState } from 'react'
import type { McpServerConfig } from '../../../../lib/contracts/config'
import { ExtensionCenter } from '../extensions/ExtensionCenter'
import { SettingsFrame, type SettingsSection } from '../extensions/SettingsFrame'
/** Compatibility for embedded settings consumers; discovery is now a marketplace source. */
export function ProjectCapabilitiesSection({ projectId }: { projectId: string; servers?: McpServerConfig[]; onSave?: (servers: McpServerConfig[]) => Promise<void> }) {
  const [section, setSection] = useState<SettingsSection>('skill')
  const selected = section === 'general' || section === 'archive' ? 'skill' : section
  return <SettingsFrame section={selected} onSelect={setSection} projectId={projectId} projectMode>
    <ExtensionCenter key={`${projectId}:${selected}`} projectId={projectId} section={selected} onNavigate={setSection} />
  </SettingsFrame>
}
