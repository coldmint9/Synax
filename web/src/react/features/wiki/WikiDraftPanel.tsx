import { useWikiStore } from '../../state/wikiStore'
import WikiDraftList from './WikiDraftList'
import WikiDraftDetail from './WikiDraftDetail'

export default function WikiDraftPanel() {
  const layer = useWikiStore(s => s.draftPanelLayer)

  return (
    <div className="flex h-full flex-col overflow-hidden border-l border-border/40 bg-card/30">
      {layer === 'list' ? <WikiDraftList /> : <WikiDraftDetail />}
    </div>
  )
}
