import { useEffect, useMemo, useState } from 'react'
import {
  Button,
  Description,
  FieldError,
  Input,
  Label,
  Modal,
  TextField,
} from '@heroui/react'
import { SettingsSelect } from '../settings/components/SettingsSelect'

export interface NewSourceForm {
  id: string
  label: string
  type: 'git-index' | 'well-known'
  repo: string
  url: string
}

interface ModalState {
  close: () => void
  open: () => void
  isOpen: boolean
}

interface Props {
  state: ModalState
  form: NewSourceForm
  busy: boolean
  error: string | null
  labels: {
    title: string
    type: string
    typeGit: string
    typeWellKnown: string
    id: string
    idHint: string
    label: string
    repo: string
    repoHint: string
    url: string
    urlHint: string
    cancel: string
    add: string
    idRequired: string
    idInvalid: string
    labelRequired: string
    repoRequired: string
    urlRequired: string
    urlInvalid: string
  }
  onChange: (patch: Partial<NewSourceForm>) => void
  onSubmit: () => void
}

const ID_PATTERN = /^[a-z0-9-]+$/

function isValidUrl(value: string): boolean {
  try {
    const parsed = new URL(value)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

export function SkillAddSourceModal({ state, form, busy, error, labels, onChange, onSubmit }: Props) {
  const [attempted, setAttempted] = useState(false)

  useEffect(() => {
    if (!state.isOpen) setAttempted(false)
  }, [state.isOpen])

  const fieldErrors = useMemo(() => {
    const id = form.id.trim()
    const label = form.label.trim()
    const repo = form.repo.trim()
    const url = form.url.trim()

    return {
      id: !id
        ? labels.idRequired
        : !ID_PATTERN.test(id)
          ? labels.idInvalid
          : null,
      label: !label ? labels.labelRequired : null,
      repo: form.type === 'git-index' && !repo ? labels.repoRequired : null,
      url: form.type === 'well-known'
        ? !url
          ? labels.urlRequired
          : !isValidUrl(url)
            ? labels.urlInvalid
            : null
        : null,
    }
  }, [form, labels])

  const hasFieldErrors = Object.values(fieldErrors).some(Boolean)

  function handleSubmit() {
    setAttempted(true)
    if (hasFieldErrors) return
    onSubmit()
  }

  return (
    <Modal state={state}>
      <Modal.Backdrop>
        <Modal.Container size="sm">
          <Modal.Dialog className="sm:max-w-md">
            <Modal.CloseTrigger />
            <Modal.Header>
              <Modal.Heading>{labels.title}</Modal.Heading>
            </Modal.Header>
            <Modal.Body className="space-y-4 px-6">
              <SettingsSelect
                label={labels.type}
                selectedKey={form.type}
                onSelectionChange={(key) => {
                  if (key === 'git-index' || key === 'well-known') {
                    onChange({ type: key })
                  }
                }}
                disallowEmptySelection
                options={[
                  { key: 'git-index', label: labels.typeGit },
                  { key: 'well-known', label: labels.typeWellKnown },
                ]}
              />

              <TextField
                isRequired
                isInvalid={attempted && Boolean(fieldErrors.id)}
                value={form.id}
                onChange={(value) => onChange({ id: value })}
              >
                <Label className="text-xs">{labels.id}</Label>
                <Input placeholder="my-skill-source" autoComplete="off" />
                <Description className="text-[11px]">{labels.idHint}</Description>
                {attempted && fieldErrors.id ? <FieldError>{fieldErrors.id}</FieldError> : null}
              </TextField>

              <TextField
                isRequired
                isInvalid={attempted && Boolean(fieldErrors.label)}
                value={form.label}
                onChange={(value) => onChange({ label: value })}
              >
                <Label className="text-xs">{labels.label}</Label>
                <Input placeholder="My Skill Source" autoComplete="off" />
                {attempted && fieldErrors.label ? <FieldError>{fieldErrors.label}</FieldError> : null}
              </TextField>

              {form.type === 'git-index' ? (
                <TextField
                  isRequired
                  isInvalid={attempted && Boolean(fieldErrors.repo)}
                  value={form.repo}
                  onChange={(value) => onChange({ repo: value })}
                >
                  <Label className="text-xs">{labels.repo}</Label>
                  <Input placeholder="owner/repo" autoComplete="off" />
                  <Description className="text-[11px]">{labels.repoHint}</Description>
                  {attempted && fieldErrors.repo ? <FieldError>{fieldErrors.repo}</FieldError> : null}
                </TextField>
              ) : (
                <TextField
                  isRequired
                  isInvalid={attempted && Boolean(fieldErrors.url)}
                  value={form.url}
                  onChange={(value) => onChange({ url: value })}
                >
                  <Label className="text-xs">{labels.url}</Label>
                  <Input
                    placeholder="https://example.com/.well-known/agent-skills/index.json"
                    autoComplete="off"
                  />
                  <Description className="text-[11px]">{labels.urlHint}</Description>
                  {attempted && fieldErrors.url ? <FieldError>{fieldErrors.url}</FieldError> : null}
                </TextField>
              )}

              {error ? (
                <p className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
                  {error}
                </p>
              ) : null}
            </Modal.Body>
            <Modal.Footer>
              <Button variant="ghost" size="sm" onPress={state.close} isDisabled={busy}>
                {labels.cancel}
              </Button>
              <Button
                variant="primary"
                size="sm"
                isPending={busy}
                onPress={handleSubmit}
              >
                {labels.add}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  )
}

export const EMPTY_SOURCE_FORM: NewSourceForm = {
  id: '',
  label: '',
  type: 'git-index',
  repo: '',
  url: '',
}
