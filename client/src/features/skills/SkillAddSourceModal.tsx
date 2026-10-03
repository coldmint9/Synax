import { useEffect, useMemo, useState } from 'react'
import { Dialog, DialogContainer, DialogPanel, DialogCloseButton, DialogHeader, DialogTitle, DialogBody, DialogFooter } from "@/shared/ui/ui/Dialog";
import { Description, FieldError, Input, Label, Field } from "@/shared/ui/ui/Field";
import { Button } from "@/shared/ui/ui/Button";
import { SettingsSelect } from '../settings/components/SettingsSelect'

export interface NewSourceForm {
  id: string
  label: string
  type: 'git-index' | 'well-known'
  repo: string
  url: string
}

interface Props {
  open: boolean
  onClose: () => void
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

export function SkillAddSourceModal({ open, onClose, form, busy, error, labels, onChange, onSubmit }: Props) {
  const [attempted, setAttempted] = useState(false)

  useEffect(() => {
    if (!open) setAttempted(false)
  }, [open])

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
    <Dialog open={open} onClose={onClose} dismissible={!busy}>
      <>
        <DialogContainer size="sm">
          <DialogPanel className="sm:max-w-md">
            <DialogCloseButton />
            <DialogHeader>
              <DialogTitle>{labels.title}</DialogTitle>
            </DialogHeader>
            <DialogBody className="space-y-4 px-6">
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

              <Field
                invalid={attempted && Boolean(fieldErrors.id)}


              >
                <Label className="text-xs">{labels.id}</Label>
                <Input placeholder="my-skill-source" autoComplete="off" required value={form.id} onChange={(event) => { const value = event.currentTarget.value; return onChange({ id: value }); }} />
                <Description className="text-[11px]">{labels.idHint}</Description>
                {attempted && fieldErrors.id ? <FieldError>{fieldErrors.id}</FieldError> : null}
              </Field>

              <Field
                invalid={attempted && Boolean(fieldErrors.label)}


              >
                <Label className="text-xs">{labels.label}</Label>
                <Input placeholder="My Skill Source" autoComplete="off" required value={form.label} onChange={(event) => { const value = event.currentTarget.value; return onChange({ label: value }); }} />
                {attempted && fieldErrors.label ? <FieldError>{fieldErrors.label}</FieldError> : null}
              </Field>

              {form.type === 'git-index' ? (
                <Field
                  invalid={attempted && Boolean(fieldErrors.repo)}


                >
                  <Label className="text-xs">{labels.repo}</Label>
                  <Input placeholder="owner/repo" autoComplete="off" required value={form.repo} onChange={(event) => { const value = event.currentTarget.value; return onChange({ repo: value }); }} />
                  <Description className="text-[11px]">{labels.repoHint}</Description>
                  {attempted && fieldErrors.repo ? <FieldError>{fieldErrors.repo}</FieldError> : null}
                </Field>
              ) : (
                <Field
                  invalid={attempted && Boolean(fieldErrors.url)}


                >
                  <Label className="text-xs">{labels.url}</Label>
                  <Input
                    placeholder="https://example.com/.well-known/agent-skills/index.json"
                    autoComplete="off" required value={form.url} onChange={(event) => { const value = event.currentTarget.value; return onChange({ url: value }); }}
                  />
                  <Description className="text-[11px]">{labels.urlHint}</Description>
                  {attempted && fieldErrors.url ? <FieldError>{fieldErrors.url}</FieldError> : null}
                </Field>
              )}

              {error ? (
                <p className="rounded-md border border-destructive/20 bg-destructive/5 px-3 py-2 text-[11px] text-destructive">
                  {error}
                </p>
              ) : null}
            </DialogBody>
            <DialogFooter>
              <Button variant="ghost" size="sm" onClick={onClose} disabled={busy}>
                {labels.cancel}
              </Button>
              <Button
                variant="primary"
                size="sm"
                pending={busy}
                onClick={handleSubmit}
              >
                {labels.add}
              </Button>
            </DialogFooter>
          </DialogPanel>
        </DialogContainer>
      </>
    </Dialog>
  )
}

export const EMPTY_SOURCE_FORM: NewSourceForm = {
  id: '',
  label: '',
  type: 'git-index',
  repo: '',
  url: '',
}
