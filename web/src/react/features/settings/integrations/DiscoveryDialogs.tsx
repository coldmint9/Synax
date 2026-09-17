import { Button, Modal } from '@heroui/react'
import { ArrowUpRight, Monitor } from 'lucide-react'
import { useLocale } from '../../../../hooks/useLocale'
import type { LocalDiscoveryResult } from '../../../../lib/api/local-discovery'
import type { DiscoveryItem as Item } from './discovery-types'
interface Props {
  detail: Item | null
  setDetail: (item: Item | null) => void
  busy: boolean
  loading: boolean
  error: string | null
  available: (item: Item) => boolean
  installed: (item: Item) => boolean
  addItems: (items: Item[]) => Promise<void>
  showLocations: boolean
  setShowLocations: (open: boolean) => void
  result: LocalDiscoveryResult | null
}
export function DiscoveryDialogs({
  detail,
  setDetail,
  busy,
  loading,
  error,
  available,
  installed,
  addItems,
  showLocations,
  setShowLocations,
  result,
}: Props) {
  const { locale } = useLocale()
  const text = (cn: string, en: string) => (locale === 'zh' ? cn : en)
  const unsupported = result?.mcp.unsupported ?? []
  return (
    <>
      <Modal
        isOpen={Boolean(detail)}
        onOpenChange={(open) => {
          if (!open) setDetail(null)
        }}
      >
        <Modal.Backdrop>
          <Modal.Container size="lg">
            <Modal.Dialog>
              <Modal.CloseTrigger />
              <Modal.Header>
                <div className="discovery-overline">
                  {detail?.kind === 'mcp' ? 'MCP SERVER' : 'SKILL'}
                </div>
                <Modal.Heading>{detail?.name}</Modal.Heading>
              </Modal.Header>
              <Modal.Body className="discovery-detail">
                {error && (
                  <p role="alert" className="text-destructive">
                    {error}
                  </p>
                )}
                {detail && (
                  <>
                    <p>{detail.description}</p>
                    <h4>{text('发现于', 'Found in')}</h4>
                    {detail.value.sources.map((s) => (
                      <div
                        className="discovery-detail-source"
                        key={`${s.client}:${s.path}`}
                      >
                        <Monitor size={14} />
                        <div>
                          <strong>
                            {s.client} ·{' '}
                            {s.scope === 'project'
                              ? text('项目', 'Project')
                              : text('用户', 'User')}
                          </strong>
                          <code>{s.path}</code>
                        </div>
                      </div>
                    ))}
                    {detail.kind === 'mcp' ? (
                      <>
                        <h4>{text('启动配置', 'Launch configuration')}</h4>
                        <pre>
                          {JSON.stringify(
                            {
                              command: detail.value.server.command,
                              args: detail.value.server.args ?? [],
                              cwd: detail.value.server.cwd,
                              env: Object.fromEntries(
                                Object.keys(detail.value.server.env ?? {}).map(
                                  (key) => [key, '••••••'],
                                ),
                              ),
                            },
                            null,
                            2,
                          )}
                        </pre>
                        <p>
                          {text(
                            '添加会保存配置；使用时才启动服务。环境变量值已隐藏。',
                            'Adding saves the configuration. The server starts when used. Environment values are hidden.',
                          )}
                        </p>
                      </>
                    ) : (
                      <>
                        <h4>{text('指令预览', 'Instructions preview')}</h4>
                        <pre>{detail.value.content}</pre>
                        <p>
                          {text(
                            '完整 Skill 文件夹将复制到当前项目的 .synax/skills，包含脚本和参考文件。',
                            'The full skill folder, including scripts and references, is copied to .synax/skills in this project.',
                          )}
                        </p>
                        {detail.value.conflict && (
                          <p className="text-warning">
                            {text(
                              '项目中已有同名 Skill。请先处理名称冲突，再重新扫描。',
                              'A different skill with this name exists in the project. Resolve the conflict and scan again.',
                            )}
                          </p>
                        )}
                      </>
                    )}
                  </>
                )}
              </Modal.Body>
              <Modal.Footer>
                <Button variant="secondary" onPress={() => setDetail(null)}>
                  {text('关闭', 'Close')}
                </Button>
                {detail && (
                  <Button
                    isPending={busy}
                    isDisabled={!available(detail) || loading}
                    onPress={() => void addItems([detail])}
                  >
                    {installed(detail)
                      ? text('已添加', 'Added')
                      : text('添加到项目', 'Add to project')}
                    <ArrowUpRight size={14} />
                  </Button>
                )}
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
      <Modal isOpen={showLocations} onOpenChange={setShowLocations}>
        <Modal.Backdrop>
          <Modal.Container size="lg">
            <Modal.Dialog>
              <Modal.CloseTrigger />
              <Modal.Header>
                <Modal.Heading>
                  {text('扫描位置', 'Scan locations')}
                </Modal.Heading>
                <p className="text-xs text-muted-foreground">
                  {text(
                    '检查常用配置位置；不会递归扫描整个磁盘。',
                    'Checks known configuration locations without traversing the entire disk.',
                  )}
                </p>
              </Modal.Header>
              <Modal.Body className="discovery-location-list">
                {unsupported.length > 0 && (
                  <div className="discovery-message is-error">
                    {text(
                      '以下 MCP 已检测到，但当前仅支持标准输入输出（stdio）连接：',
                      'These MCP servers were detected, but only stdio connections are currently supported:',
                    )}
                    <ul>
                      {unsupported.map((item, i) => (
                        <li key={i}>
                          {item.name} · {item.client}
                          <code>{item.path}</code>
                          <small>{item.reason}</small>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {result?.locations.map((location, index) => (
                  <div className="discovery-location" key={index}>
                    <span
                      className={`discovery-location-dot is-${location.status}`}
                    />
                    <div>
                      <strong>
                        {location.client}
                        <span>
                          {location.kind === 'mcp' ? 'MCP' : 'Skills'}
                        </span>
                      </strong>
                      <code>{location.path}</code>
                      {location.message && <p>{location.message}</p>}
                    </div>
                    <small>
                      {location.status === 'missing'
                        ? text('未找到', 'Not found')
                        : location.status === 'error'
                          ? text('需检查', 'Check')
                          : text(
                              `${location.count} 项`,
                              `${location.count} found`,
                            )}
                    </small>
                  </div>
                ))}
              </Modal.Body>
              <Modal.Footer>
                <Button
                  variant="secondary"
                  onPress={() => setShowLocations(false)}
                >
                  {text('完成', 'Done')}
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </>
  )
}
