import { useState } from 'react'
import { Zap, X, Loader2 } from 'lucide-react'
import { Button, Modal } from '@heroui/react'
import { useLocale } from '../../../hooks/useLocale'
import { useWikiStore } from '../../state/wikiStore'
import { type WikiPlanNode } from '../../../lib/api/goal'
import PlanDAGView from './PlanDAGView'

interface Props {
  projectId: string
}

export default function PlanDraftView({ projectId }: Props) {
  const { t } = useLocale()
  const activePlan = useWikiStore(s => s.activePlan)
  const nodes = useWikiStore(s => s.activePlanNodes)
  const confirmPlan = useWikiStore(s => s.confirmPlan)
  const discardPlan = useWikiStore(s => s.discardPlan)
  const updatePlanNode = useWikiStore(s => s.updatePlanNode)
  const setViewMode = useWikiStore(s => s.setViewMode)

  const [confirming, setConfirming] = useState(false)
  const [editingNode, setEditingNode] = useState<WikiPlanNode | null>(null)

  if (!activePlan) return null

  async function handleConfirm() {
    if (!activePlan) return
    setConfirming(true)
    try {
      await confirmPlan(projectId, activePlan.id)
    } finally {
      setConfirming(false)
    }
  }

  async function handleDiscard() {
    if (!activePlan) return
    await discardPlan(activePlan.id)
    setViewMode('document')
  }

  return (
    <div className="flex h-full flex-col overflow-hidden">
      <div className="flex h-11 shrink-0 items-center justify-between border-b border-border/15 px-5">
        <div className="flex items-center gap-2.5">
          <Zap size={14} className="text-amber-500" />
          <span className="text-[13px] font-semibold text-foreground/80">{t('planDraftTitle')}</span>
          <span className="text-[11px] text-muted-foreground/50">
            {t('planBasedOnGoals', { goals: activePlan.goalIds.length, nodes: nodes.length })}
          </span>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onPress={handleDiscard}>
            <X size={12} />
            {t('planDraftDiscard')}
          </Button>
          <Button variant="primary" size="sm" onPress={handleConfirm} isDisabled={confirming || nodes.length === 0}>
            {confirming ? <Loader2 size={12} className="animate-spin" /> : <Zap size={12} />}
            {t('planDraftConfirm')}
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1">
        <PlanDAGView
          nodes={nodes}
          onNodeClick={(node) => { if ('id' in node) setEditingNode(node as WikiPlanNode) }}
        />
      </div>

      {editingNode && (
        <NodeEditModal
          node={editingNode}
          projectId={projectId}
          onClose={() => setEditingNode(null)}
          onSave={async (updates) => {
            await updatePlanNode(editingNode.id, updates)
            setEditingNode(null)
          }}
        />
      )}
    </div>
  )
}

function NodeEditModal({ node, projectId, onClose, onSave }: {
  node: WikiPlanNode
  projectId: string
  onClose: () => void
  onSave: (updates: Partial<Pick<WikiPlanNode, 'title' | 'description' | 'expectedFiles'>>) => Promise<void>
}) {
  const { t } = useLocale()
  const [title, setTitle] = useState(node.title)
  const [description, setDescription] = useState(node.description)
  const [files, setFiles] = useState(node.expectedFiles.join(', '))
  const [saving, setSaving] = useState(false)

  async function handleSave() {
    setSaving(true)
    try {
      await onSave({
        title,
        description,
        expectedFiles: files.split(',').map(f => f.trim()).filter(Boolean),
      })
    } finally {
      setSaving(false)
    }
  }

  return (
    <Modal.Backdrop isOpen onOpenChange={(open) => { if (!open) onClose() }}>
      <Modal.Container size="md">
        <Modal.Dialog>
          <Modal.Header>
            <Modal.Heading>{t('planEditNodeTitle')}</Modal.Heading>
          </Modal.Header>
          <Modal.Body>
            <div className="space-y-3">
              <div>
                <label className="text-[11px] font-medium text-muted-foreground/70 mb-1 block">{t('planEditTitle')}</label>
                <input
                  value={title}
                  onChange={e => setTitle(e.target.value)}
                  className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-[12px] focus:border-primary/40 focus:outline-none"
                />
              </div>
              <div>
                <label className="text-[11px] font-medium text-muted-foreground/70 mb-1 block">{t('planEditDescription')}</label>
                <textarea
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  rows={4}
                  className="w-full resize-none rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-[12px] focus:border-primary/40 focus:outline-none"
                />
              </div>
              <div>
                <label className="text-[11px] font-medium text-muted-foreground/70 mb-1 block">{t('planEditExpectedFiles')}</label>
                <input
                  value={files}
                  onChange={e => setFiles(e.target.value)}
                  className="w-full rounded-lg border border-border/30 bg-background/60 px-3 py-2 text-[11px] font-mono focus:border-primary/40 focus:outline-none"
                />
              </div>
            </div>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="ghost" size="sm" onPress={onClose}>{t('commonCancel')}</Button>
            <Button variant="primary" size="sm" onPress={handleSave} isDisabled={saving || !title.trim()}>
              {saving ? <Loader2 size={12} className="animate-spin" /> : null}
              {t('commonSave')}
            </Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  )
}
