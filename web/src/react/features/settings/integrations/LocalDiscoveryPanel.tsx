import { DiscoveryDialogs } from './DiscoveryDialogs'
import type { DiscoveryItem as Item } from './discovery-types'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Button, Checkbox, Input, TextField } from '@heroui/react'
import {
  ArrowDownToLine,
  Check,
  ChevronRight,
  CircleAlert,
  FolderPlus,
  FolderSearch,
  Layers3,
  Plug,
  RefreshCw,
  Search,
  Sparkles,
  X,
} from 'lucide-react'
import { useLocale } from '../../../../hooks/useLocale'
import {
  localDiscoveryApi,
  mcpSignature,
  type LocalDiscoveryResult,
} from '../../../../lib/api/local-discovery'
import type { McpServerConfig } from '../../../../lib/contracts/config'
import { DirectoryPickerDialog } from '../../../components/directory-picker/DirectoryPickerDialog'

interface Props {
  projectId: string
  servers: McpServerConfig[]
  onSave: (servers: McpServerConfig[]) => Promise<void>
}

export function LocalDiscoveryPanel({ projectId, servers, onSave }: Props) {
  const { locale } = useLocale()
  const zh = locale === 'zh'
  const text = (cn: string, en: string) => (zh ? cn : en)
  const [result, setResult] = useState<LocalDiscoveryResult | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState('')
  const [directories, setDirectories] = useState<string[]>([])
  const [picker, setPicker] = useState(false)
  const [source, setSource] = useState('all')
  const [kind, setKind] = useState('all')
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<Set<string>>(new Set())
  const [detail, setDetail] = useState<Item | null>(null)
  const [showLocations, setShowLocations] = useState(false)
  const [busy, setBusy] = useState(false)
  const lock = useRef(false)
  const request = useRef(0)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      request.current++
    }
  }, [])
  const scan = useCallback(async () => {
    const id = ++request.current
    setLoading(true)
    setError(null)
    try {
      const data = await localDiscoveryApi.scan(projectId, directories)
      if (id === request.current) {
        setResult(data)
        setSelected(new Set())
      }
    } catch (err) {
      if (id === request.current)
        setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (id === request.current) setLoading(false)
    }
  }, [projectId, directories])
  useEffect(() => {
    void scan()
    return () => {
      request.current++
    }
  }, [scan])

  const items = useMemo<Item[]>(
    () => [
      ...(result?.mcp.servers ?? []).map((value) => ({
        id: `mcp:${value.fingerprint}`,
        name: value.server.name,
        description: `${value.server.command} · ${value.server.args?.find((arg) => /^@[^\s]+\//.test(arg)) ?? 'stdio'}`,
        kind: 'mcp' as const,
        value,
      })),
      ...(result?.skills ?? []).map((value) => ({
        id: `skill:${value.id}`,
        name: value.name,
        description: value.description,
        kind: 'skill' as const,
        value,
      })),
    ],
    [result],
  )
  const configured = new Set(servers.map(mcpSignature))
  const installed = (item: Item) =>
    item.kind === 'mcp'
      ? configured.has(mcpSignature(item.value.server))
      : item.value.installed
  const blocked = (item: Item) => item.kind === 'skill' && item.value.conflict
  const available = (item: Item) => !installed(item) && !blocked(item)
  const clients = useMemo(
    () =>
      [
        ...new Set(
          (result?.locations ?? []).map((location) => location.client),
        ),
      ].sort((a, b) => {
        const rank = (name: string) =>
          name === 'Claude Code' ? 0 : name === 'Codex' ? 1 : 2
        return rank(a) - rank(b) || a.localeCompare(b)
      }),
    [result],
  )
  const sourceItems = items.filter(
    (item) =>
      source === 'all' || item.value.sources.some((s) => s.client === source),
  )
  const filtered = sourceItems.filter(
    (item) =>
      (kind === 'all' || item.kind === kind) &&
      `${item.name} ${item.description} ${item.value.sources.map((s) => s.path).join(' ')}`
        .toLowerCase()
        .includes(query.toLowerCase().trim()),
  )
  const selectable = filtered.filter(available)
  const selectedItems = items.filter(
    (item) => selected.has(item.id) && available(item),
  )
  const warnings =
    result?.locations.filter((location) => location.status === 'error') ?? []
  const unsupported = result?.mcp.unsupported ?? []
  const toggle = (id: string, checked: boolean) =>
    setSelected((current) => {
      const next = new Set(current)
      if (checked) next.add(id)
      else next.delete(id)
      return next
    })

  async function addItems(targets: Item[]) {
    if (lock.current || loading) return
    lock.current = true
    setBusy(true)
    setError(null)
    setNotice('')
    const completed = new Set<string>()
    try {
      const mcps = targets.filter(
        (item) => item.kind === 'mcp' && available(item),
      )
      if (mcps.length) {
        const next = [...servers]
        for (const item of mcps) {
          if (item.kind !== 'mcp') continue
          let id = item.value.server.id
          let suffix = 2
          while (next.some((server) => server.id === id))
            id = `${item.value.server.id}-${suffix++}`
          next.push({ ...item.value.server, id, enabled: true })
        }
        await onSave(next)
        mcps.forEach((item) => completed.add(item.id))
      }
      for (const item of targets) {
        if (item.kind !== 'skill' || !available(item)) continue
        await localDiscoveryApi.importSkill(
          projectId,
          item.value.id,
          directories,
        )
        completed.add(item.id)
        if (mounted.current)
          setResult(
            (current) =>
              current && {
                ...current,
                skills: current.skills.map((skill) =>
                  skill.id === item.value.id
                    ? { ...skill, installed: true }
                    : skill,
                ),
              },
          )
      }
      if (mounted.current) setDetail(null)
    } catch (err) {
      if (mounted.current)
        setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (mounted.current) {
        setSelected(
          (current) => new Set([...current].filter((id) => !completed.has(id))),
        )
        if (completed.size)
          setNotice(
            text(
              `已将 ${completed.size} 项能力添加到当前项目`,
              `Added ${completed.size} capabilities to this project`,
            ),
          )
        setBusy(false)
      }
      lock.current = false
    }
  }

  return (
    <div className="local-discovery">
      <div className="discovery-intro">
        <div className="discovery-intro-icon">
          <FolderSearch size={23} strokeWidth={1.5} />
        </div>
        <div className="min-w-0 flex-1">
          <h3>
            {text(
              '让熟悉的工具，在这里继续工作',
              'Bring your familiar tools along',
            )}
          </h3>
          <p>
            {text(
              '自动发现这台机器上的 MCP 与 Skill，选择后添加到当前项目。',
              'Discover MCP servers and skills on this machine. Add the ones you need to this project.',
            )}
          </p>
        </div>
        <Button
          size="sm"
          variant="secondary"
          isPending={loading}
          isDisabled={busy}
          onPress={() => void scan()}
        >
          {({ isPending }) => (
            <>
              {!isPending && <RefreshCw size={13} />}
              {text('重新扫描', 'Rescan')}
            </>
          )}
        </Button>
      </div>
      <div className="discovery-layout">
        <aside
          className="discovery-sources"
          aria-label={text('发现来源', 'Discovery sources')}
        >
          <div className="discovery-overline">
            {text('本地来源', 'LOCAL SOURCES')}
          </div>
          <button
            className={`discovery-source ${source === 'all' ? 'is-active' : ''}`}
            aria-pressed={source === 'all'}
            onClick={() => setSource('all')}
          >
            <Layers3 size={15} />
            <span>{text('全部来源', 'All sources')}</span>
            <small>{items.length}</small>
          </button>
          {clients
            .filter(
              (client) =>
                ['Claude Code', 'Codex'].includes(client) ||
                items.some((item) =>
                  item.value.sources.some((s) => s.client === client),
                ),
            )
            .map((client) => (
              <button
                key={client}
                className={`discovery-source ${source === client ? 'is-active' : ''}`}
                aria-pressed={source === client}
                onClick={() => setSource(client)}
              >
                <span
                  className={`discovery-client-mark ${client === 'Claude Code' ? 'is-claude' : ''}`}
                >
                  {client === 'Claude Code'
                    ? '✳'
                    : client === 'Codex'
                      ? '⌘'
                      : client.charAt(0)}
                </span>
                <span>{client}</span>
                <small>
                  {
                    items.filter((item) =>
                      item.value.sources.some((s) => s.client === client),
                    ).length
                  }
                </small>
              </button>
            ))}
          <div className="discovery-source-footer">
            <Button
              size="sm"
              variant="ghost"
              isDisabled={busy || loading || directories.length >= 8}
              onPress={() => setPicker(true)}
            >
              <FolderPlus size={14} />
              {text('添加扫描目录', 'Add directory')}
            </Button>
            {directories.map((directory) => (
              <div className="discovery-custom-path" key={directory}>
                <span title={directory}>{directory}</span>
                <Button
                  size="sm"
                  isIconOnly
                  variant="ghost"
                  isDisabled={busy || loading}
                  aria-label={text(
                    `移除扫描目录 ${directory}`,
                    `Remove directory ${directory}`,
                  )}
                  onPress={() =>
                    setDirectories((current) =>
                      current.filter((d) => d !== directory),
                    )
                  }
                >
                  <X size={11} />
                </Button>
              </div>
            ))}
            <button
              className="discovery-scan-summary"
              onClick={() => setShowLocations(true)}
            >
              <span
                className={`discovery-status-dot ${loading ? 'is-scanning' : ''}`}
              />
              {loading
                ? text('正在扫描…', 'Scanning…')
                : text(
                    `已检查 ${result?.locations.length ?? 0} 个位置`,
                    `${result?.locations.length ?? 0} locations checked`,
                  )}
              <ChevronRight size={12} />
            </button>
            <p>
              {text(
                '扫描运行 Synax 的机器。添加后保留原工具配置。',
                'Scans the machine running Synax. Your original tool configuration is preserved.',
              )}
            </p>
          </div>
        </aside>
        <section
          className="discovery-results"
          aria-label={text('发现结果', 'Discovery results')}
          aria-busy={loading}
        >
          <div className="discovery-toolbar">
            <div
              className="discovery-filters"
              aria-label={text('能力类型', 'Capability type')}
            >
              {(['all', 'mcp', 'skill'] as const).map((value) => (
                <Button
                  key={value}
                  size="sm"
                  variant={kind === value ? 'secondary' : 'ghost'}
                  aria-pressed={kind === value}
                  onPress={() => setKind(value)}
                >
                  {value === 'all'
                    ? text('全部', 'All')
                    : value === 'mcp'
                      ? 'MCP'
                      : 'Skills'}
                  <span>
                    {
                      sourceItems.filter(
                        (item) => value === 'all' || item.kind === value,
                      ).length
                    }
                  </span>
                </Button>
              ))}
            </div>
            <TextField
              aria-label={text(
                '搜索名称、描述或路径',
                'Search names, descriptions or paths',
              )}
              className="discovery-search"
              value={query}
              onChange={setQuery}
            >
              <Search size={13} />
              <Input placeholder={text('搜索能力…', 'Search capabilities…')} />
            </TextField>
          </div>
          {error && (
            <div className="discovery-message is-error" role="alert">
              <CircleAlert size={14} />
              <span>{error}</span>
              <Button
                size="sm"
                variant="ghost"
                isDisabled={loading || busy}
                onPress={() => void scan()}
              >
                {text('重试扫描', 'Retry scan')}
              </Button>
            </div>
          )}
          {notice && (
            <div className="discovery-message" role="status">
              <Check size={14} />
              {notice}
            </div>
          )}
          {(warnings.length > 0 || unsupported.length > 0) && (
            <button
              className="discovery-diagnostics"
              onClick={() => setShowLocations(true)}
            >
              <CircleAlert size={13} />
              {text(
                `${warnings.length} 个位置需要检查 · ${unsupported.length} 个 MCP 暂不支持`,
                `${warnings.length} locations need attention · ${unsupported.length} unsupported MCP servers`,
              )}
              <ChevronRight size={12} />
            </button>
          )}
          <div className="discovery-list-heading">
            <Checkbox
              aria-label={text(
                '选择所有可添加的结果',
                'Select all available results',
              )}
              isDisabled={!selectable.length || busy || loading}
              isSelected={
                selectable.length > 0 &&
                selectable.every((item) => selected.has(item.id))
              }
              isIndeterminate={
                selectable.some((item) => selected.has(item.id)) &&
                !selectable.every((item) => selected.has(item.id))
              }
              onChange={(checked) =>
                setSelected((current) => {
                  const next = new Set(current)
                  selectable.forEach((item) =>
                    checked ? next.add(item.id) : next.delete(item.id),
                  )
                  return next
                })
              }
            >
              <Checkbox.Content><Checkbox.Control>
                <Checkbox.Indicator />
              </Checkbox.Control></Checkbox.Content>
            </Checkbox>
            <span>
              {text(
                `${filtered.length} 项能力`,
                `${filtered.length} capabilities`,
              )}
            </span>
            <span className="ml-auto">
              {text('仅在添加后接入', 'Connected when added')}
            </span>
          </div>
          <div className="discovery-list">
            {loading && !result ? (
              <div
                role="status"
                aria-label={text(
                  '正在发现本地能力',
                  'Discovering local capabilities',
                )}
              >
                {Array.from({ length: 4 }, (_, index) => (
                  <div className="discovery-skeleton" key={index}>
                    <i />
                    <div>
                      <i />
                      <i />
                    </div>
                  </div>
                ))}
              </div>
            ) : filtered.length === 0 ? (
              <div className="discovery-empty">
                <FolderSearch size={28} strokeWidth={1.3} />
                <h4>
                  {query || source !== 'all' || kind !== 'all'
                    ? text('没有匹配的能力', 'No matching capabilities')
                    : text('还没有发现本地能力', 'No local capabilities found')}
                </h4>
                <p>
                  {text(
                    '试试其他来源，或选择保存配置和 Skill 的目录。',
                    'Try another source, or choose a directory containing configs and skills.',
                  )}
                </p>
                <Button
                  size="sm"
                  variant="secondary"
                  isDisabled={busy || loading}
                  onPress={() => {
                    setQuery('')
                    setSource('all')
                    setKind('all')
                    setPicker(true)
                  }}
                >
                  <FolderPlus size={13} />
                  {text('选择目录', 'Choose directory')}
                </Button>
              </div>
            ) : (
              filtered.map((item) => (
                <div
                  className={`discovery-row ${selected.has(item.id) ? 'is-selected' : ''}`}
                  key={item.id}
                >
                  <Checkbox
                    aria-label={text(
                      `选择 ${item.name}`,
                      `Select ${item.name}`,
                    )}
                    isSelected={selected.has(item.id)}
                    isDisabled={!available(item) || busy || loading}
                    onChange={(checked) => toggle(item.id, checked)}
                  >
                    <Checkbox.Content><Checkbox.Control>
                      <Checkbox.Indicator />
                    </Checkbox.Control></Checkbox.Content>
                  </Checkbox>
                  <button
                    className="discovery-row-detail"
                    onClick={() => setDetail(item)}
                    aria-label={text(
                      `查看 ${item.name} 详情`,
                      `View ${item.name} details`,
                    )}
                  >
                    <span
                      className={`discovery-kind-icon ${item.kind === 'skill' ? 'is-skill' : ''}`}
                    >
                      {item.kind === 'mcp' ? (
                        <Plug size={17} strokeWidth={1.6} />
                      ) : (
                        <Sparkles size={17} strokeWidth={1.6} />
                      )}
                    </span>
                    <span className="discovery-row-copy">
                      <span className="discovery-row-title">
                        {item.name}
                        <span className="discovery-type-label">
                          {item.kind === 'mcp' ? 'MCP' : 'SKILL'}
                        </span>
                      </span>
                      <span className="discovery-row-description">
                        {item.description}
                      </span>
                      <span className="discovery-row-origin">
                        {[
                          ...new Set(item.value.sources.map((s) => s.client)),
                        ].join(' · ')}
                        <span> / </span>
                        {item.value.sources.some((s) => s.scope === 'project')
                          ? text('项目', 'Project')
                          : text('用户目录', 'User directory')}
                      </span>
                    </span>
                  </button>
                  {installed(item) ? (
                    <span className="discovery-added">
                      <Check size={12} />
                      {text('已添加', 'Added')}
                    </span>
                  ) : blocked(item) ? (
                    <span className="discovery-conflict">
                      {text('同名冲突', 'Name conflict')}
                    </span>
                  ) : (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="discovery-add"
                      isDisabled={busy || loading}
                      aria-label={text(`添加 ${item.name}`, `Add ${item.name}`)}
                      onPress={() => void addItems([item])}
                    >
                      <ArrowDownToLine size={14} />
                      <span>{text('添加', 'Add')}</span>
                    </Button>
                  )}
                </div>
              ))
            )}
          </div>
          <footer className="discovery-selection-bar">
            <span>
              {selectedItems.length
                ? text(
                    `已选 ${selectedItems.length} 项`,
                    `${selectedItems.length} selected`,
                  )
                : text(
                    '选择你想带入项目的能力',
                    'Choose what to bring into this project',
                  )}
            </span>
            <Button
              size="sm"
              isPending={busy}
              isDisabled={!selectedItems.length || loading}
              onPress={() => void addItems(selectedItems)}
            >
              {({ isPending }) => (
                <>
                  {!isPending && <ArrowDownToLine size={13} />}
                  {text('添加到项目', 'Add to project')}
                  {selectedItems.length > 0 && ` · ${selectedItems.length}`}
                </>
              )}
            </Button>
          </footer>
        </section>
      </div>
      <DirectoryPickerDialog
        open={picker}
        onClose={() => setPicker(false)}
        onSelect={({ path }) => {
          setDirectories((current) =>
            [...new Set([...current, path])].slice(0, 8),
          )
          setPicker(false)
        }}
        labels={{
          title: text('添加扫描目录', 'Add scan directory'),
          hint: text(
            '选择工具配置目录、Skill 集合或单个 Skill 文件夹。',
            'Choose a tool config directory, skill collection or individual skill folder.',
          ),
          confirm: text('扫描此目录', 'Scan this directory'),
        }}
      />
      <DiscoveryDialogs
        detail={detail}
        setDetail={setDetail}
        busy={busy}
        loading={loading}
        error={error}
        available={available}
        installed={installed}
        addItems={addItems}
        showLocations={showLocations}
        setShowLocations={setShowLocations}
        result={result}
      />
    </div>
  )
}
