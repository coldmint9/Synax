import { useRef, useState } from 'react'
import { Dialog, DialogContainer, DialogPanel, DialogHeader, DialogTitle, DialogBody, DialogFooter } from "@/shared/ui/ui/Dialog";
import { Input, Label, TextArea, Field } from "@/shared/ui/ui/Field";
import { Button } from "@/shared/ui/ui/Button";
import { AppSelect } from '../../../shared/ui/AppSelect'
import {
  extensionsApi,
  type CustomExtensionInput,
  type ExtensionKind,
} from '../../../adapters/transport/extensions'
import { configApi } from '../../../adapters/transport/config'
import type { ExtensionDetail } from './ExtensionDetails'
import { useExtensionCopy } from './extension-copy'
import { McpConfigFields } from './McpConfigFields'
import { createMcpDraft, readMcpDraft } from './mcp-draft'

const emptySchema =
  '{\n  "type": "object",\n  "properties": {},\n  "additionalProperties": false\n}'
function mapJson(value: string): Record<string, string> {
  if (!value.trim()) return {}
  const parsed = JSON.parse(value)
  if (
    !parsed ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    Object.values(parsed).some((value) => typeof value !== 'string')
  )
    throw new Error('Expected a JSON object with string values')
  return parsed
}
export function CustomExtensionEditor({
  projectId,
  initialKind,
  detail,
  onClose,
  onSaved,
}: {
  projectId: string
  initialKind: ExtensionKind
  detail?: ExtensionDetail
  onClose: () => void
  onSaved: (kind: ExtensionKind) => void
}) {
  const copy = useExtensionCopy()
  const definition = detail?.definition
  const [kind, setKind] = useState<ExtensionKind>(
    detail?.item.kind ?? initialKind,
  )
  const [name, setName] = useState(detail?.item.name ?? '')
  const [description, setDescription] = useState(detail?.item.description ?? '')
  const [mode, setMode] = useState<'command' | 'http'>(
    definition?.tool?.mode ??
      (definition?.mcp?.transport === 'http' ? 'http' : 'command'),
  )
  const [command, setCommand] = useState(
    definition?.tool?.command ?? definition?.mcp?.command ?? '',
  )
  const [args, setArgs] = useState(
    (definition?.tool?.args ?? definition?.mcp?.args ?? []).join('\n'),
  )
  const [url, setUrl] = useState(
    definition?.tool?.url ?? definition?.mcp?.url ?? '',
  )
  const [cwd, setCwd] = useState(
    definition?.tool?.cwd ?? definition?.mcp?.cwd ?? '',
  )
  const [headers, setHeaders] = useState(
    JSON.stringify(
      definition?.tool?.headers ?? definition?.mcp?.headers ?? {},
      null,
      2,
    ),
  )
  const [schema, setSchema] = useState(
    definition?.tool?.inputSchema
      ? JSON.stringify(definition.tool.inputSchema, null, 2)
      : emptySchema,
  )
  const [timeout, setTimeoutValue] = useState(
    String((definition?.tool?.timeoutMs ?? 30000) / 1000),
  )
  const [content, setContent] = useState(detail?.content ?? '')
  const [mcpDraft, setMcpDraft] = useState(() => createMcpDraft(definition?.mcp, detail?.item.name, detail?.item.description))
  const [error, setError] = useState('')
  const [testMessage, setTestMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const submitting = useRef(false)
  const fileInput = useRef<HTMLInputElement>(null)
  function input(): CustomExtensionInput {
    if (kind === 'mcp') return { id: detail?.item.id, kind, ...readMcpDraft(mcpDraft, definition?.mcp?.id) }
    const common = {
      id: detail?.item.id,
      kind,
      name: name.trim(),
      description: description.trim(),
    }
    if (
      !common.name ||
      !common.description ||
      (kind === 'skill'
        ? !content.trim()
        : mode === 'command'
          ? !command.trim()
          : !url.trim())
    )
      throw new Error(copy.required)
    const argsList = args
      .split('\n')
      .map((value) => value.trim())
      .filter(Boolean)
    if (kind === 'skill') return { ...common, content }
    return {
      ...common,
      tool: {
        mode,
        ...(mode === 'command'
          ? {
              command: command.trim(),
              args: argsList,
              ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
            }
          : { url: url.trim(), headers: mapJson(headers) }),
        inputSchema: JSON.parse(schema),
        timeoutMs: Number(timeout) * 1000,
      },
    }
  }
  async function save() {
    if (submitting.current) return
    submitting.current = true
    setBusy(true)
    setError('')
    try {
      await extensionsApi.saveCustom(projectId, input())
      onSaved(kind)
    } catch (error) {
      setError(error instanceof Error ? error.message : copy.error)
    } finally {
      submitting.current = false
      setBusy(false)
    }
  }
  return (
    <Dialog
      open
      onClose={() => { if (!busy && !testing) onClose(); }} dismissible={!busy && !testing}
    >
      <>
        <DialogContainer size="lg">
          <DialogPanel>
            <DialogHeader>
              <DialogTitle>{detail ? copy.edit : copy.create}</DialogTitle>
            </DialogHeader>
            <DialogBody>
              <fieldset disabled={busy || testing} className="extension-form">
                {!detail && (
                  <AppSelect
                    label={copy.type}
                    value={kind}
                    onChange={(value) => { setKind(value as ExtensionKind); setError(''); setTestMessage('') }}
                    options={(['tool', 'skill', 'mcp'] as const).map((key) => ({
                      key,
                      label: copy[key],
                    }))}
                  />
                )}
                {kind === 'mcp' ? (
                  <McpConfigFields draft={mcpDraft} onChange={value => { setMcpDraft(value); setError(''); setTestMessage('') }} />
                ) : <>
                <Field>
                  <Label>{copy.name}</Label>
                  <Input autoFocus maxLength={128} required value={name} onChange={(event) => (setName)(event.currentTarget.value)} />
                </Field>
                <Field>
                  <Label>{copy.description}</Label>
                  <Input maxLength={4000} required value={description} onChange={(event) => (setDescription)(event.currentTarget.value)} />
                </Field>
                {kind === 'skill' ? (
                  <>
                    <Field>
                      <Label>{copy.content}</Label>
                      <TextArea className="extension-markdown" required value={content} onChange={(event) => (setContent)(event.currentTarget.value)} />
                    </Field>
                    <div>
                      <Button
                        size="sm"
                        variant="secondary"
                        onClick={() => fileInput.current?.click()}
                      >
                        {copy.importFile}
                      </Button>
                      <input
                        ref={fileInput}
                        type="file"
                        accept=".md,.markdown"
                        hidden
                        onChange={async (event) => {
                          const file = event.target.files?.[0]
                          if (!file) return
                          if (file.size > 256 * 1024) {
                            setError('SKILL.md exceeds 256 KB')
                            return
                          }
                          setContent(await file.text())
                        }}
                      />
                    </div>
                    <p className="extension-form-note">{copy.skillNote}</p>
                  </>
                ) : (
                  <>
                    <AppSelect
                      label={copy.mode}
                      value={mode}
                      onChange={(value) => setMode(value as 'command' | 'http')}
                      options={[
                        { key: 'command', label: copy.localCommand },
                        {
                          key: 'http',
                          label: copy.http,
                        },
                      ]}
                    />
                    {mode === 'command' ? (
                      <>
                        <Field>
                          <Label>{copy.command}</Label>
                          <Input placeholder={copy.commandHint} required value={command} onChange={(event) => (setCommand)(event.currentTarget.value)} />
                        </Field>
                        <Field>
                          <Label>{copy.args}</Label>
                          <TextArea className="font-mono text-xs" rows={3} value={args} onChange={(event) => (setArgs)(event.currentTarget.value)} />
                        </Field>
                      </>
                    ) : (
                      <Field>
                        <Label>{copy.endpoint}</Label>
                        <Input type="url" placeholder="https://" required value={url} onChange={(event) => (setUrl)(event.currentTarget.value)} />
                      </Field>
                    )}
                    {kind === 'tool' && (
                      <p className="extension-form-note">
                        {mode === 'command' ? copy.commandNote : copy.httpNote}
                      </p>
                    )}
                    <details>
                      <summary>{copy.advanced}</summary>
                      <div className="extension-form">
                        {mode === 'command' && (
                          <Field>
                            <Label>{copy.cwd}</Label>
                            <Input value={cwd} onChange={(event) => (setCwd)(event.currentTarget.value)} />
                          </Field>
                        )}

                        {mode === 'http' && (
                          <Field>
                            <Label>{copy.headers}</Label>
                            <TextArea className="font-mono text-xs" value={headers} onChange={(event) => (setHeaders)(event.currentTarget.value)} />
                          </Field>
                        )}
                        {kind === 'tool' && (
                          <>
                            <Field>
                              <Label>{copy.schema}</Label>
                              <TextArea
                                rows={6}
                                className="font-mono text-xs" value={schema} onChange={(event) => (setSchema)(event.currentTarget.value)}
                              />
                            </Field>
                            <Field>
                              <Label>{copy.timeout}</Label>
                              <Input type="number" min={1} max={120} value={timeout} onChange={(event) => (setTimeoutValue)(event.currentTarget.value)} />
                            </Field>
                          </>
                        )}
                      </div>
                    </details>

                  </>
                )}
                </>}
                {error && (
                  <p role="alert" className="extension-error">
                    {error}
                  </p>
                )}
                {testMessage && (
                  <p role="status" className="extension-form-note">
                    {testMessage}
                  </p>
                )}
              </fieldset>
            </DialogBody>
            <DialogFooter>
              <Button
                size="sm"
                variant="tertiary"
                disabled={busy || testing}
                onClick={onClose}
              >
                {copy.cancel}
              </Button>
              {kind === 'mcp' && (
                <Button
                  size="sm"
                  variant="secondary"
                  pending={testing}
                  disabled={busy}
                  onClick={async () => {
                    setError('')
                    setTestMessage('')
                    setTesting(true)
                    try {
                      const result = await configApi.testMcpServer(input().mcp!, projectId)
                      if (!result.ok) throw new Error(result.error)
                      setTestMessage(
                        `${copy.connected} · ${result.tools.length}`,
                      )
                    } catch (error) {
                      setError(
                        error instanceof Error ? error.message : copy.error,
                      )
                    } finally {
                      setTesting(false)
                    }
                  }}
                >
                  {copy.connection}
                </Button>
              )}
              <Button
                size="sm"
                pending={busy}
                disabled={testing}
                onClick={() => void save()}
              >
                {copy.save}
              </Button>
            </DialogFooter>
          </DialogPanel>
        </DialogContainer>
      </>
    </Dialog>
  )
}
