import { Button, Input, Modal, Switch } from '@heroui/react'

interface ModalState {
  close: () => void
  open: () => void
  isOpen: boolean
}

interface NewSourceForm {
  id: string
  label: string
  type: 'git-index' | 'well-known'
  repo: string
  url: string
}

interface Props {
  state: ModalState
  form: NewSourceForm
  busy: boolean
  labels: {
    title: string
    id: string
    label: string
    wellKnown: string
    repo: string
    url: string
    cancel: string
    add: string
  }
  onChange: (patch: Partial<NewSourceForm>) => void
  onSubmit: () => void
}

export function SkillAddSourceModal({ state, form, busy, labels, onChange, onSubmit }: Props) {
  return (
    <Modal state={state}>
      <Modal.Backdrop>
        <Modal.Container>
          <Modal.Dialog className="max-w-md">
            <Modal.Header>{labels.title}</Modal.Header>
            <Modal.Body className="space-y-3">
              <Input
                label={labels.id}
                value={form.id}
                onChange={(e) => onChange({ id: e.target.value })}
              />
              <Input
                label={labels.label}
                value={form.label}
                onChange={(e) => onChange({ label: e.target.value })}
              />
              <div className="flex items-center justify-between rounded-lg border border-border/40 px-3 py-2">
                <span className="text-[11px] text-foreground">{labels.wellKnown}</span>
                <Switch
                  isSelected={form.type === 'well-known'}
                  onChange={(selected) => onChange({ type: selected ? 'well-known' : 'git-index' })}
                >
                  <Switch.Control><Switch.Thumb /></Switch.Control>
                </Switch>
              </div>
              {form.type === 'git-index' ? (
                <Input
                  label={labels.repo}
                  value={form.repo}
                  onChange={(e) => onChange({ repo: e.target.value })}
                  placeholder="owner/repo"
                />
              ) : (
                <Input
                  label={labels.url}
                  value={form.url}
                  onChange={(e) => onChange({ url: e.target.value })}
                  placeholder="https://example.com/.well-known/agent-skills/index.json"
                />
              )}
            </Modal.Body>
            <Modal.Footer>
              <Button variant="secondary" onPress={state.close}>{labels.cancel}</Button>
              <Button variant="primary" isDisabled={busy} onPress={onSubmit}>
                {labels.add}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  )
}
