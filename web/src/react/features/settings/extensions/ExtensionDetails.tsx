import { useEffect, useState } from 'react'
import { Drawer, DialogContainer, DialogPanel, DialogCloseButton, DialogHeader, DialogTitle, DialogBody, DialogFooter } from "@/react/components/ui/Dialog";
import { Spinner } from "@/react/components/ui/Display";
import { Button } from "@/react/components/ui/Button";
import {
  extensionsApi,
  type ExtensionItem,
} from '../../../../lib/api/extensions'
import { useExtensionCopy } from './extension-copy'
export type ExtensionDetail = Awaited<ReturnType<typeof extensionsApi.detail>>
export function ExtensionDetails({
  projectId,
  item,
  busy,
  onClose,
  onEdit,
  onInstall,
  onUninstall,
}: {
  projectId: string
  item: ExtensionItem | null
  busy: boolean
  onClose: () => void
  onEdit: (detail: ExtensionDetail) => void
  onInstall: (item: ExtensionItem) => void
  onUninstall: (item: ExtensionItem) => void
}) {
  const copy = useExtensionCopy()
  const [detail, setDetail] = useState<ExtensionDetail | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  useEffect(() => {
    let active = true
    setDetail(null)
    setError('')
    setLoading(false)
    if (
      !item ||
      (!item.installed &&
        !item.editable &&
        !item.sourceId.startsWith('catalog/'))
    )
      return
    setLoading(true)
    extensionsApi
      .detail(projectId, item)
      .then((value) => {
        if (active) setDetail(value)
      })
      .catch((error) => {
        if (active) setError(String(error.message ?? error))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [projectId, item])
  const source =
    item?.sourceId === 'local'
      ? copy.local
      : item?.sourceId === 'builtin'
        ? copy.builtin
        : item?.sourceId === 'custom'
          ? copy.custom
          : item?.sourceLabel
  return (
    <Drawer
      open={Boolean(item)}
      onClose={onClose}
    >
      <>
        <DialogContainer >
          <DialogPanel className="extension-drawer">
            <DialogCloseButton aria-label={copy.close} />
            <DialogHeader>
              <DialogTitle>{item?.name}</DialogTitle>
            </DialogHeader>
            <DialogBody className="extension-detail-body">
              <p className="extension-detail-description">
                {item?.description}
              </p>
              <dl className="extension-detail-meta">
                <dt>{copy.type}</dt>
                <dd>{item && copy[item.kind]}</dd>
                <dt>{copy.source}</dt>
                <dd>{source}</dd>
                {item?.version && (
                  <>
                    <dt>{copy.version}</dt>
                    <dd>{item.version}</dd>
                  </>
                )}
                {!!item?.permissions?.length && (
                  <>
                    <dt>{copy.permissions}</dt>
                    <dd>{item.permissions.join(' · ')}</dd>
                  </>
                )}
              </dl>
              {item?.conflict && (
                <p role="alert" className="extension-error">
                  {item.conflict}
                </p>
              )}
              {loading && <Spinner size="sm" />}
              {error && (
                <p role="alert" className="extension-error">
                  {error}
                </p>
              )}
              {detail?.content && (
                <pre className="extension-detail-content">{detail.content}</pre>
              )}
              {detail?.definition?.tool && (
                <pre className="extension-detail-content">
                  {JSON.stringify(
                    { ...detail.definition.tool, headers: undefined },
                    null,
                    2,
                  )}
                </pre>
              )}
              {detail?.definition?.mcp && (
                <pre className="extension-detail-content">
                  {JSON.stringify(
                    {
                      ...detail.definition.mcp,
                      env: undefined,
                      headers: undefined,
                    },
                    null,
                    2,
                  )}
                </pre>
              )}
              {item?.detail && !detail?.content && (
                <p className="break-all font-mono text-xs text-muted-foreground">
                  {item.detail}
                </p>
              )}
            </DialogBody>
            <DialogFooter>
              {item?.installed ? (
                <>
                  <Button
                    size="sm"
                    variant="danger-soft"
                    disabled={busy}
                    onClick={() => onUninstall(item)}
                  >
                    {copy.uninstall}
                  </Button>
                  {item.editable && (
                    <Button
                      size="sm"
                      disabled={!detail || busy}
                      onClick={() => {
                        if (detail) onEdit(detail)
                      }}
                    >
                      {copy.edit}
                    </Button>
                  )}
                </>
              ) : (
                item && (
                  <Button
                    size="sm"
                    disabled={busy || Boolean(item.conflict)}
                    onClick={() => onInstall(item)}
                  >
                    {copy.install}
                  </Button>
                )
              )}
            </DialogFooter>
          </DialogPanel>
        </DialogContainer>
      </>
    </Drawer>
  )
}
