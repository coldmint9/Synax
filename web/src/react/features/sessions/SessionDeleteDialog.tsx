import { Button, Modal } from '@heroui/react'
import { Trash2 } from 'lucide-react'
import { useLocale } from '../../../hooks/useLocale'

interface Props {
  isOpen: boolean
  sessionTitle: string
  isDeleting: boolean
  onConfirm: () => void
  onClose: () => void
}

export function SessionDeleteDialog({ isOpen, sessionTitle, isDeleting, onConfirm, onClose }: Props) {
  const { t } = useLocale()
  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={open => { if (!open) onClose() }}>
      <Modal.Container size="sm">
        <Modal.Dialog>
          <Modal.Header>
            <Modal.Icon><Trash2 className="text-danger" size={18} /></Modal.Icon>
            <Modal.Heading>{t('sessionDelete')}</Modal.Heading>
          </Modal.Header>
          <Modal.Body>
            {t('sessionDeleteConfirm', { title: sessionTitle })}
          </Modal.Body>
          <Modal.Footer>
            <Button variant="ghost" onPress={onClose} size="sm">Cancel</Button>
            <Button variant="danger" onPress={onConfirm} isPending={isDeleting} size="sm">{t('sessionDelete')}</Button>
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  )
}
