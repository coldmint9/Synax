import { useRef, useState } from 'react'
import { Button, Input, Label, Modal, TextArea, TextField } from '@heroui/react'
import { AppSelect } from '../../../components/AppSelect'
import {
  extensionsApi,
  type CustomExtensionInput,
  type ExtensionKind,
} from '../../../../lib/api/extensions'
import { configApi } from '../../../../lib/api/config'
import type { ExtensionDetail } from './ExtensionDetails'
import { useExtensionCopy } from './extension-copy'

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
  const [env, setEnv] = useState(
    JSON.stringify(definition?.mcp?.env ?? {}, null, 2),
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
  const [importJson, setImportJson] = useState('')
  const [error, setError] = useState('')
  const [testMessage, setTestMessage] = useState('')
  const [busy, setBusy] = useState(false)
  const [testing, setTesting] = useState(false)
  const submitting = useRef(false)
  const fileInput = useRef<HTMLInputElement>(null)
  function input(): CustomExtensionInput {
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
    if (kind === 'mcp')
      return {
        ...common,
        mcp: {
          id: common.id ?? 'custom-preview',
          name: common.name,
          transport: mode === 'http' ? 'http' : 'stdio',
          command: mode === 'command' ? command.trim() : '',
          ...(mode === 'http'
            ? { url: url.trim(), headers: mapJson(headers) }
            : {
                args: argsList,
                env: mapJson(env),
                ...(cwd.trim() ? { cwd: cwd.trim() } : {}),
              }),
        },
      }
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
  function applyImport() {
    try {
      let parsed = JSON.parse(importJson)
      if (parsed.mcpServers) {
        const entries = Object.entries(parsed.mcpServers)
        if (entries.length !== 1) throw new Error(copy.configImportHint)
        setName(entries[0][0])
        parsed = entries[0][1]
      }
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        (!parsed.command && !parsed.url)
      )
        throw new Error(copy.configImportHint)
      setMode(parsed.url ? 'http' : 'command')
      setCommand(parsed.command ?? '')
      setArgs((parsed.args ?? []).join('\n'))
      setUrl(parsed.url ?? '')
      setCwd(parsed.cwd ?? '')
      setEnv(JSON.stringify(parsed.env ?? {}, null, 2))
      setHeaders(JSON.stringify(parsed.headers ?? {}, null, 2))
      setImportJson('')
      setError('')
    } catch (error) {
      setError(error instanceof Error ? error.message : copy.invalidJson)
    }
  }
  return (
    <Modal
      isOpen
      onOpenChange={(open) => {
        if (!open && !busy && !testing) onClose()
      }}
    >
      <Modal.Backdrop isDismissable={!busy && !testing}>
        <Modal.Container size="lg">
          <Modal.Dialog>
            <Modal.Header>
              <Modal.Heading>{detail ? copy.edit : copy.create}</Modal.Heading>
            </Modal.Header>
            <Modal.Body>
              <fieldset disabled={busy || testing} className="extension-form">
                {!detail && (
                  <AppSelect
                    label={copy.type}
                    value={kind}
                    onChange={(value) => setKind(value as ExtensionKind)}
                    options={(['tool', 'skill', 'mcp'] as const).map((key) => ({
                      key,
                      label: copy[key],
                    }))}
                  />
                )}
                <TextField isRequired value={name} onChange={setName}>
                  <Label>{copy.name}</Label>
                  <Input autoFocus maxLength={128} />
                </TextField>
                <TextField
                  isRequired
                  value={description}
                  onChange={setDescription}
                >
                  <Label>{copy.description}</Label>
                  <Input maxLength={4000} />
                </TextField>
                {kind === 'skill' ? (
                  <>
                    <TextField isRequired value={content} onChange={setContent}>
                      <Label>{copy.content}</Label>
                      <TextArea className="extension-markdown" />
                    </TextField>
                    <div>
                      <Button
                        size="sm"
                        variant="secondary"
                        onPress={() => fileInput.current?.click()}
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
                          label: kind === 'mcp' ? copy.remoteMcp : copy.http,
                        },
                      ]}
                    />
                    {mode === 'command' ? (
                      <>
                        <TextField
                          isRequired
                          value={command}
                          onChange={setCommand}
                        >
                          <Label>{copy.command}</Label>
                          <Input placeholder={copy.commandHint} />
                        </TextField>
                        <TextField value={args} onChange={setArgs}>
                          <Label>{copy.args}</Label>
                          <TextArea className="font-mono text-xs" rows={3} />
                        </TextField>
                      </>
                    ) : (
                      <TextField isRequired value={url} onChange={setUrl}>
                        <Label>{copy.endpoint}</Label>
                        <Input type="url" placeholder="https://" />
                      </TextField>
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
                          <TextField value={cwd} onChange={setCwd}>
                            <Label>{copy.cwd}</Label>
                            <Input />
                          </TextField>
                        )}
                        {kind === 'mcp' && mode === 'command' && (
                          <TextField value={env} onChange={setEnv}>
                            <Label>{copy.env}</Label>
                            <TextArea className="font-mono text-xs" />
                          </TextField>
                        )}
                        {mode === 'http' && (
                          <TextField value={headers} onChange={setHeaders}>
                            <Label>{copy.headers}</Label>
                            <TextArea className="font-mono text-xs" />
                          </TextField>
                        )}
                        {kind === 'tool' && (
                          <>
                            <TextField value={schema} onChange={setSchema}>
                              <Label>{copy.schema}</Label>
                              <TextArea
                                rows={6}
                                className="font-mono text-xs"
                              />
                            </TextField>
                            <TextField
                              value={timeout}
                              onChange={setTimeoutValue}
                            >
                              <Label>{copy.timeout}</Label>
                              <Input type="number" min={1} max={120} />
                            </TextField>
                          </>
                        )}
                      </div>
                    </details>
                    {kind === 'mcp' && (
                      <details>
                        <summary>{copy.importConfig}</summary>
                        <div className="extension-form">
                          <p className="extension-form-note">
                            {copy.configImportHint}
                          </p>
                          <TextField
                            value={importJson}
                            onChange={setImportJson}
                            aria-label={copy.importConfig}
                          >
                            <TextArea rows={5} className="font-mono text-xs" />
                          </TextField>
                          <Button
                            size="sm"
                            variant="secondary"
                            onPress={applyImport}
                            isDisabled={!importJson.trim()}
                          >
                            {copy.applyConfig}
                          </Button>
                        </div>
                      </details>
                    )}
                  </>
                )}
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
            </Modal.Body>
            <Modal.Footer>
              <Button
                size="sm"
                variant="tertiary"
                isDisabled={busy || testing}
                onPress={onClose}
              >
                {copy.cancel}
              </Button>
              {kind === 'mcp' && (
                <Button
                  size="sm"
                  variant="secondary"
                  isPending={testing}
                  isDisabled={busy}
                  onPress={async () => {
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
                isPending={busy}
                isDisabled={testing}
                onPress={() => void save()}
              >
                {copy.save}
              </Button>
            </Modal.Footer>
          </Modal.Dialog>
        </Modal.Container>
      </Modal.Backdrop>
    </Modal>
  )
}
