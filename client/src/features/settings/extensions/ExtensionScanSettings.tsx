import { useEffect, useRef, useState } from 'react'
import {
  Drawer,
  DialogContainer,
  DialogPanel,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
} from '@/shared/ui/ui/Dialog'
import { Label, TextArea, Field } from '@/shared/ui/ui/Field'
import { Button } from '@/shared/ui/ui/Button'
import {
  extensionsApi,
  type ExtensionKind,
} from '../../../adapters/transport/extensions'
import { useExtensionCopy } from './extension-copy'

export function ExtensionScanSettings({
  projectId,
  kind,
  onClose,
  onSaved,
}: {
  projectId: string
  kind: ExtensionKind
  onClose: () => void
  onSaved: () => void
}) {
  const copy = useExtensionCopy()
  const [directories, setDirectories] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [loaded, setLoaded] = useState(false)
  const [error, setError] = useState('')
  const [revision, setRevision] = useState(0)
  const submitting = useRef(false)
  useEffect(() => {
    let active = true
    setLoading(true)
    setLoaded(false)
    setError('')
    extensionsApi
      .sources(projectId)
      .then((value) => {
        if (active) {
          setDirectories(value.directories.join('\n'))
          setLoaded(true)
        }
      })
      .catch((error) => {
        if (active)
          setError(error instanceof Error ? error.message : copy.error)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [projectId, revision, copy.error])

  async function save() {
    if (submitting.current) return
    submitting.current = true
    setBusy(true)
    setError('')
    try {
      await extensionsApi.saveDirectories(
        projectId,
        directories
          .split('\n')
          .map((value) => value.trim())
          .filter(Boolean),
      )
      onSaved()
    } catch (error) {
      setError(error instanceof Error ? error.message : copy.error)
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }

  return (
    <Drawer
      open
      onClose={() => {
        if (!busy) onClose()
      }}
      dismissible={!busy}
    >
      <DialogContainer>
        <DialogPanel className="extension-drawer">
          <DialogHeader>
            <DialogTitle>{copy.localSettings}</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <div className="extension-form">
              <p className="extension-form-note">{copy[`${kind}LocalHint`]}</p>
              <p className="extension-form-note">
                {copy.sharedDirectoriesHint}
              </p>
              <Field disabled={loading || busy || !loaded}>
                <Label>{copy.directories}</Label>
                <TextArea
                  rows={4}
                  placeholder="/path/to/extensions"
                  className="font-mono text-xs"
                  value={directories}
                  onChange={(event) =>
                    setDirectories(event.currentTarget.value)
                  }
                />
              </Field>
              {kind === 'tool' && (
                <details>
                  <summary>{copy.localManifest}</summary>
                  <pre className="extension-detail-content">
                    {JSON.stringify(
                      {
                        tools: [
                          {
                            name: 'Project check',
                            description: 'Check this project',
                            tool: {
                              mode: 'command',
                              command: 'node',
                              args: ['check.js'],
                              inputSchema: { type: 'object', properties: {} },
                            },
                          },
                        ],
                      },
                      null,
                      2,
                    )}
                  </pre>
                </details>
              )}
              {error && (
                <p
                  role="alert"
                  data-error-toast="off"
                  className="extension-error"
                >
                  {error}
                </p>
              )}
              {!loaded && !loading && (
                <Button
                  size="sm"
                  variant="secondary"
                  onClick={() => setRevision((value) => value + 1)}
                >
                  {copy.retry}
                </Button>
              )}
            </div>
          </DialogBody>
          <DialogFooter>
            <Button
              size="sm"
              variant="tertiary"
              disabled={busy}
              onClick={onClose}
            >
              {copy.cancel}
            </Button>
            <Button
              size="sm"
              pending={busy}
              disabled={loading || !loaded}
              onClick={() => void save()}
            >
              {copy.saveAndRescan}
            </Button>
          </DialogFooter>
        </DialogPanel>
      </DialogContainer>
    </Drawer>
  )
}
