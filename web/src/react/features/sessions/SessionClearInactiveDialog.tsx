import { Button, Modal } from '@heroui/react'
import { Trash2 } from 'lucide-react'
import { useState } from 'react'
import { agentRuntimeApi } from '../../../lib/api/agentRuntime'

interface Props {
  isOpen: boolean
  projectId: string | null
  onClose: () => void
  onCleared: () => void
}

export function SessionClearInactiveDialog({ isOpen, projectId, onClose, onCleared }: Props) {
  const [deleting, setDeleting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const handleClear = async () => {
    if (!projectId) return
    setError(null)
    setDeleting(true)
    try {
      const result = await agentRuntimeApi.clearInactiveSessions(projectId)
      onClose()
      onCleared()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to clear sessions')
      console.error('[ClearInactive]', err)
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={open => { if (!open) onClose() }}>
      <Modal.Container size="sm">
        <Modal.Dialog>
          <Modal.Header>
            <Modal.Icon><Trash2 className="text-danger" size={18} /></Modal.Icon>
            <Modal.Heading>Clear Inactive Sessions</Modal.Heading>
          </Modal.Header>
          <Modal.Body>
            <p>Delete all non-running sessions? This cannot be undone.</p>
            {error && <p className="text-danger text-xs mt-2">{error}</p>}
          </Modal.Body>
          <Modal.Footer>
            <Button variant="ghost" onPress={onClose} size="sm">Cancel</Button>
            <Button
              variant="danger"
              onPress={handleClear}
              isPending={deleting}
              isDisabled={!projectId}
              size="sm"
            >Clear Inactive</Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  )
}
