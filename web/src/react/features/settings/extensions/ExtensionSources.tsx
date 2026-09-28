import { useEffect, useState } from 'react'
import { Drawer, DialogContainer, DialogPanel, DialogHeader, DialogTitle, DialogBody, DialogFooter } from "@/react/components/ui/Dialog";
import { Input, Label, TextArea, Field } from "@/react/components/ui/Field";
import { Button } from "@/react/components/ui/Button";
import { Plus, RefreshCw } from 'lucide-react'
import {
  extensionsApi,
  type ExtensionSource,
} from '../../../../lib/api/extensions'
import { skillSourcesApi } from '../../../../lib/api/skills'
import { AppSelect } from '../../../components/AppSelect'
import { useExtensionCopy } from './extension-copy'
export function ExtensionSources({
  projectId,
  onClose,
  onChanged,
}: {
  projectId: string
  onClose: () => void
  onChanged: () => void
}) {
  const copy = useExtensionCopy()
  const [sources, setSources] = useState<ExtensionSource[]>([])
  const [directories, setDirectories] = useState('')
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [adding, setAdding] = useState(false)
  const [sourceId, setSourceId] = useState('')
  const [label, setLabel] = useState('')
  const [type, setType] = useState<'catalog' | 'well-known' | 'git-index'>(
    'catalog',
  )
  const [url, setUrl] = useState('')
  useEffect(() => {
    let active = true
    extensionsApi
      .sources(projectId)
      .then((value) => {
        if (active) {
          setSources(value.items)
          setDirectories(value.directories.join('\n'))
        }
      })
      .catch((error) => {
        if (active) setError(error.message)
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [projectId])
  async function action(operation: () => Promise<unknown>) {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await operation()
      onChanged()
    } catch (error) {
      setError(error instanceof Error ? error.message : copy.error)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Drawer
      open
      onClose={() => { if (!busy) onClose(); }} dismissible={!busy}
    >
      <>
        <DialogContainer >
          <DialogPanel className="extension-drawer">
            <DialogHeader>
              <DialogTitle>{copy.sources}</DialogTitle>
            </DialogHeader>
            <DialogBody>
              <section className="extension-form">
                <h3 className="text-sm font-medium">{copy.local}</h3>
                <p className="extension-form-note">{copy.localHint}</p>
                <Field
                  disabled={loading || busy}
                >
                  <Label>{copy.directories}</Label>
                  <TextArea
                    rows={4}
                    placeholder="/path/to/extensions"
                    className="font-mono text-xs" value={directories} onChange={(event) => (setDirectories)(event.currentTarget.value)}
                  />
                </Field>
                <Button
                  size="sm"
                  variant="secondary"
                  disabled={loading || busy}
                  onClick={() =>
                    void action(() =>
                      extensionsApi.saveDirectories(
                        projectId,
                        directories
                          .split('\n')
                          .map((value) => value.trim())
                          .filter(Boolean),
                      ),
                    )
                  }
                >
                  {copy.save}
                </Button>
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
              </section>
              <div className="mt-7">
                <p className="extension-form-note">{copy.remoteHint}</p>
                {sources
                  .filter((source) => source.kind === 'remote')
                  .map((source) => (
                    <div key={source.id} className="extension-source-row">
                      <div className="min-w-0">
                        <strong>{source.name}</strong>
                        <p>{source.description}</p>
                      </div>
                      <Button
                        size="sm"
                        variant="ghost"
                        iconOnly
                        aria-label={`${copy.sync}: ${source.name}`}
                        disabled={busy}
                        onClick={() =>
                          void action(() =>
                            source.id.startsWith('catalog/')
                              ? extensionsApi.syncSource(projectId, source.id)
                              : skillSourcesApi.sync(source.id),
                          )
                        }
                      >
                        <RefreshCw size={15} />
                      </Button>
                    </div>
                  ))}
              </div>
              {adding ? (
                <fieldset disabled={busy} className="extension-form mt-6">
                  <Field>
                    <Label>{copy.sourceName}</Label>
                    <Input value={label} onChange={(event) => (setLabel)(event.currentTarget.value)} required />
                  </Field>
                  <Field>
                    <Label>{copy.sourceId}</Label>
                    <Input placeholder="my-team" pattern="[a-z0-9-]+" value={sourceId} onChange={(event) => (setSourceId)(event.currentTarget.value)} required />
                  </Field>
                  <AppSelect
                    label={copy.type}
                    value={type}
                    onChange={(value) => setType(value as typeof type)}
                    options={[
                      { key: 'catalog', label: copy.catalog },
                      { key: 'well-known', label: copy.index },
                      { key: 'git-index', label: copy.git },
                    ]}
                  />
                  <Field>
                    <Label>{copy.sourceUrl}</Label>
                    <Input
                      placeholder={
                        type === 'git-index'
                          ? 'owner/repository'
                          : 'https://example.com/skills.json'
                      } value={url} onChange={(event) => (setUrl)(event.currentTarget.value)} required
                    />
                  </Field>
                  {type === 'catalog' && (
                    <details>
                      <summary>{copy.remoteManifest}</summary>
                      <pre className="extension-detail-content">
                        {JSON.stringify(
                          {
                            extensions: [
                              {
                                id: 'review',
                                version: '1.0.0',
                                definition: {
                                  kind: 'skill',
                                  name: 'Review',
                                  description: 'Team review guide',
                                  content: 'Check changes and tests.',
                                },
                              },
                              {
                                id: 'check',
                                definition: {
                                  kind: 'tool',
                                  name: 'Check',
                                  description: 'Project checks',
                                  tool: {
                                    mode: 'command',
                                    command: 'node',
                                    args: ['check.js'],
                                    inputSchema: { type: 'object' },
                                  },
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
                  <Button
                    size="sm"
                    disabled={
                      busy ||
                      !label.trim() ||
                      !/^[a-z0-9-]+$/.test(sourceId) ||
                      !url.trim()
                    }
                    onClick={() =>
                      void action(async () => {
                        if (type === 'catalog')
                          await extensionsApi.addSource(projectId, {
                            id: sourceId,
                            name: label.trim(),
                            url: url.trim(),
                          })
                        else
                          await skillSourcesApi.create({
                            id: sourceId,
                            label: label.trim(),
                            type,
                            config:
                              type === 'git-index'
                                ? {
                                    repo: url.trim(),
                                    ref: 'main',
                                    indexPath: 'skills-index.json',
                                  }
                                : { url: url.trim() },
                          })
                        setAdding(false)
                        setSourceId('')
                        setLabel('')
                        setUrl('')
                        setSources(
                          (await extensionsApi.sources(projectId)).items,
                        )
                        if (type !== 'catalog')
                          await skillSourcesApi.sync(sourceId)
                      })
                    }
                  >
                    {copy.addSource}
                  </Button>
                </fieldset>
              ) : (
                <Button
                  size="sm"
                  variant="ghost"
                  className="mt-4"
                  onClick={() => setAdding(true)}
                >
                  <Plus size={14} />
                  {copy.addSource}
                </Button>
              )}
              {error && (
                <p role="alert" className="extension-error">
                  {error}
                </p>
              )}
            </DialogBody>
            <DialogFooter>
              <Button
                size="sm"
                variant="tertiary"
                disabled={busy}
                onClick={onClose}
              >
                {copy.close}
              </Button>
            </DialogFooter>
          </DialogPanel>
        </DialogContainer>
      </>
    </Drawer>
  )
}
