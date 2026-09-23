import { useEffect, useState } from 'react'
import {
  Button,
  Drawer,
  Input,
  Label,
  TextArea,
  TextField,
} from '@heroui/react'
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
      isOpen
      onOpenChange={(open) => {
        if (!open && !busy) onClose()
      }}
    >
      <Drawer.Backdrop isDismissable={!busy}>
        <Drawer.Content placement="right">
          <Drawer.Dialog className="extension-drawer">
            <Drawer.Header>
              <Drawer.Heading>{copy.sources}</Drawer.Heading>
            </Drawer.Header>
            <Drawer.Body>
              <section className="extension-form">
                <h3 className="text-sm font-medium">{copy.local}</h3>
                <p className="extension-form-note">{copy.localHint}</p>
                <TextField
                  value={directories}
                  onChange={setDirectories}
                  isDisabled={loading || busy}
                >
                  <Label>{copy.directories}</Label>
                  <TextArea
                    rows={4}
                    placeholder="/path/to/extensions"
                    className="font-mono text-xs"
                  />
                </TextField>
                <Button
                  size="sm"
                  variant="secondary"
                  isDisabled={loading || busy}
                  onPress={() =>
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
                        isIconOnly
                        aria-label={`${copy.sync}: ${source.name}`}
                        isDisabled={busy}
                        onPress={() =>
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
                  <TextField value={label} onChange={setLabel} isRequired>
                    <Label>{copy.sourceName}</Label>
                    <Input />
                  </TextField>
                  <TextField value={sourceId} onChange={setSourceId} isRequired>
                    <Label>{copy.sourceId}</Label>
                    <Input placeholder="my-team" pattern="[a-z0-9-]+" />
                  </TextField>
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
                  <TextField value={url} onChange={setUrl} isRequired>
                    <Label>{copy.sourceUrl}</Label>
                    <Input
                      placeholder={
                        type === 'git-index'
                          ? 'owner/repository'
                          : 'https://example.com/skills.json'
                      }
                    />
                  </TextField>
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
                    isDisabled={
                      busy ||
                      !label.trim() ||
                      !/^[a-z0-9-]+$/.test(sourceId) ||
                      !url.trim()
                    }
                    onPress={() =>
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
                  onPress={() => setAdding(true)}
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
            </Drawer.Body>
            <Drawer.Footer>
              <Button
                size="sm"
                variant="tertiary"
                isDisabled={busy}
                onPress={onClose}
              >
                {copy.close}
              </Button>
            </Drawer.Footer>
          </Drawer.Dialog>
        </Drawer.Content>
      </Drawer.Backdrop>
    </Drawer>
  )
}
