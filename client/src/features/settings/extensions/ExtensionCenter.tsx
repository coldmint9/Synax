import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertDialog,
  DialogContainer,
  DialogPanel,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
} from '@/shared/ui/ui/Dialog'
import { Spinner } from '@/shared/ui/ui/Display'
import {
  InputGroup,
  Field,
  InputPrefix,
  Input,
  InputSuffix,
} from '@/shared/ui/ui/Field'
import { Button } from '@/shared/ui/ui/Button'
import { Compass, FolderSearch, Plus, RefreshCw, Search, X } from 'lucide-react'
import {
  extensionsApi,
  type ExtensionItem,
  type ExtensionKind,
  type ExtensionList,
} from '../../../adapters/transport/extensions'
import { ExtensionRow } from './ExtensionRow'
import { ExtensionDetails, type ExtensionDetail } from './ExtensionDetails'
import { CustomExtensionEditor } from './CustomExtensionEditor'
import { ExtensionScanSettings } from './ExtensionScanSettings'
import {
  Tab,
  TabGroup,
  TabList,
  TabPanel,
  TabPanels,
} from '../../../shared/ui/ui/Tabs'
import { useExtensionCopy } from './extension-copy'
import './extensions.css'

const PAGE_SIZE = 30
const EMPTY_RESULT: ExtensionList = {
  items: [],
  total: 0,
  hasMore: false,
  warnings: [],
}

type CatalogView = 'installed' | 'local' | 'builtin'

export function ExtensionCenter({
  projectId,
  section,
  onNavigate,
}: {
  projectId: string
  section: ExtensionKind | 'market'
  onNavigate: (section: ExtensionKind | 'market') => void
}) {
  return section === 'market' ? (
    <ExtensionMarketplace projectId={projectId} onNavigate={onNavigate} />
  ) : (
    <ExtensionCatalog
      key={`${projectId}:${section}`}
      projectId={projectId}
      section={section}
      onNavigate={onNavigate}
    />
  )
}

function ExtensionMarketplace({
  projectId,
  onNavigate,
}: {
  projectId: string
  onNavigate: (section: ExtensionKind) => void
}) {
  const copy = useExtensionCopy()
  const [adding, setAdding] = useState(false)
  return (
    <section className="extension-page" aria-label={copy.market}>
      <header className="extension-page-heading">
        <div>
          <h1>{copy.market}</h1>
          <p>{copy.marketHint}</p>
        </div>
        <Button size="sm" variant="secondary" onClick={() => setAdding(true)}>
          <Plus size={15} />
          {copy.addExtension}
        </Button>
      </header>
      <div className="extension-market-empty">
        <Compass size={30} strokeWidth={1.3} aria-hidden="true" />
        <h2>{copy.enterpriseMarket}</h2>
        <p>{copy.enterpriseMarketHint}</p>
      </div>
      {adding && (
        <CustomExtensionEditor
          projectId={projectId}
          initialKind="tool"
          onClose={() => setAdding(false)}
          onSaved={(kind) => {
            setAdding(false)
            onNavigate(kind)
          }}
        />
      )}
    </section>
  )
}

function ExtensionCatalog({
  projectId,
  section,
  onNavigate,
}: {
  projectId: string
  section: ExtensionKind
  onNavigate: (section: ExtensionKind) => void
}) {
  const copy = useExtensionCopy()
  const [view, setView] = useState<CatalogView>('installed')
  const views: CatalogView[] =
    section === 'mcp'
      ? ['installed', 'local']
      : ['installed', 'local', 'builtin']
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [offset, setOffset] = useState(0)
  const [revision, setRevision] = useState(0)
  const [result, setResult] = useState<ExtensionList>(EMPTY_RESULT)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [selected, setSelected] = useState<ExtensionItem | null>(null)
  const [remove, setRemove] = useState<ExtensionItem | null>(null)
  const [editor, setEditor] = useState<{ detail?: ExtensionDetail } | null>(
    null,
  )
  const [showSources, setShowSources] = useState(false)
  const generation = useRef(0)
  const lock = useRef(false)
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
      generation.current++
    }
  }, [])
  useEffect(() => {
    if (query.trim() === debounced) return
    const timer = window.setTimeout(() => {
      setDebounced(query.trim())
      setOffset(0)
      setRevision((value) => value + 1)
    }, 250)
    return () => window.clearTimeout(timer)
  }, [query, debounced])
  const scope = JSON.stringify([
    projectId,
    section,
    view,
    query,
    debounced,
    offset,
    revision,
  ])
  const currentScope = useRef(scope)
  currentScope.current = scope
  const reload = useCallback(async () => {
    if (
      currentScope.current !== scope ||
      query.trim() !== debounced ||
      !mounted.current
    )
      return
    const token = ++generation.current
    setLoading(true)
    try {
      const next = await extensionsApi.list(projectId, {
        view: view === 'installed' ? 'installed' : 'market',
        kind: section,
        source: view === 'installed' ? undefined : view,
        q: debounced || undefined,
        offset,
        limit: PAGE_SIZE,
      })
      if (
        token !== generation.current ||
        currentScope.current !== scope ||
        !mounted.current
      )
        return
      if (offset > 0 && next.total <= offset) {
        setOffset(
          Math.max(0, Math.ceil(next.total / PAGE_SIZE) - 1) * PAGE_SIZE,
        )
        return
      }
      setResult(next)
      setError('')
    } catch (error) {
      if (
        token === generation.current &&
        currentScope.current === scope &&
        mounted.current
      ) {
        setError(error instanceof Error ? error.message : 'Request failed')
      }
    } finally {
      if (
        token === generation.current &&
        currentScope.current === scope &&
        mounted.current
      )
        setLoading(false)
    }
  }, [projectId, section, view, query, debounced, offset, scope])
  const refresh = useRef(reload)
  refresh.current = reload
  useEffect(() => {
    void reload()
    return () => {
      generation.current++
    }
  }, [reload])
  async function act(operation: () => Promise<unknown>, done?: () => void) {
    if (lock.current) return
    lock.current = true
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await operation()
      if (mounted.current) {
        done?.()
        await refresh.current()
      }
    } catch (error) {
      if (mounted.current)
        setError(error instanceof Error ? error.message : copy.error)
    } finally {
      lock.current = false
      if (mounted.current) setBusy(false)
    }
  }
  async function edit(item: ExtensionItem) {
    await act(async () => {
      const detail = await extensionsApi.detail(projectId, item)
      if (mounted.current) {
        setSelected(null)
        setEditor({ detail })
      }
    })
  }
  const isSearching = Boolean(query.trim())
  function changeView(next: CatalogView) {
    generation.current++
    setView(next)
    setOffset(0)
    setQuery('')
    setDebounced('')
    setResult(EMPTY_RESULT)
    setLoading(true)
    setError('')
    setNotice('')
  }
  function showInstalled() {
    changeView('installed')
    setRevision((value) => value + 1)
  }
  const renderRows = () => (
    <ul>
      {result.items.map((item) => (
        <ExtensionRow
          key={`${item.kind}:${item.id}`}
          item={item}
          showSource={view === 'local'}
          busy={busy || loading}
          onOpen={() => setSelected(item)}
          onInstall={() =>
            void act(
              () => extensionsApi.install(projectId, item),
              () => setNotice(copy.installedNotice),
            )
          }
          onToggle={(enabled) =>
            void act(() =>
              extensionsApi.changeState(
                projectId,
                item,
                enabled ? 'enable' : 'disable',
              ),
            )
          }
          onEdit={() => void edit(item)}
          onUninstall={() => {
            setError('')
            setRemove(item)
          }}
        />
      ))}
    </ul>
  )
  const content = (
    <>
      {view === 'local' && (
        <div className="extension-discovery-heading">
          <p>{copy[`${section}LocalHint`]}</p>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShowSources(true)}
          >
            <FolderSearch size={15} />
            {copy.localSettings}
          </Button>
        </div>
      )}
      <div className="extension-toolbar">
        <Field className="extension-search">
          <InputGroup>
            <InputPrefix>
              <Search size={15} />
            </InputPrefix>
            <Input
              type="search"
              placeholder={copy.search}
              aria-label={copy.search}
              value={query}
              onChange={(event) => {
                generation.current++
                setQuery(event.currentTarget.value)
                setLoading(true)
              }}
            />
            {query && (
              <InputSuffix>
                <Button
                  size="sm"
                  variant="ghost"
                  iconOnly
                  aria-label={copy.clear}
                  onClick={() => {
                    generation.current++
                    setQuery('')
                    setLoading(true)
                  }}
                >
                  <X size={13} />
                </Button>
              </InputSuffix>
            )}
          </InputGroup>
        </Field>
        <Button
          size="sm"
          variant="ghost"
          iconOnly
          aria-label={view === 'local' ? copy.rescan : copy.refresh}
          disabled={loading || busy}
          onClick={() => void reload()}
        >
          <RefreshCw size={15} />
        </Button>
      </div>
      {error && !remove && (
        <p role="alert" data-error-toast="off" className="extension-error">
          {error}
        </p>
      )}
      {notice && (
        <div role="status" className="extension-success">
          <span>{notice}</span>
          <Button size="sm" variant="ghost" onClick={showInstalled}>
            {copy.viewInstalled}
          </Button>
        </div>
      )}
      {result.warnings.length > 0 && (
        <details className="extension-notice">
          <summary>{copy.sourceError}</summary>
          {result.warnings.map((message, index) => (
            <p key={index}>{message}</p>
          ))}
        </details>
      )}
      <div className="extension-list-meta">
        <span>
          {copy[view]}
          {!loading &&
            ` · ${result.totalExact === false ? '≥ ' : ''}${result.total}`}
        </span>
        {loading && <Spinner size="sm" />}
      </div>
      <div aria-busy={loading}>
        {result.items.length > 0 ? (
          renderRows()
        ) : !loading && !error ? (
          <div className="extension-empty">
            <FolderSearch
              size={26}
              strokeWidth={1.3}
              className="text-muted-foreground"
            />
            <h2>
              {isSearching
                ? copy.noResults
                : view === 'local'
                  ? copy.localEmpty
                  : copy.empty}
            </h2>
            <p>
              {isSearching
                ? copy.noResultsHint
                : view === 'local'
                  ? copy.localEmptyHint
                  : copy.emptyHint}
            </p>
            {!isSearching && view === 'installed' && (
              <Button
                size="sm"
                variant="secondary"
                onClick={() => changeView('local')}
              >
                <FolderSearch size={15} />
                {copy.local}
              </Button>
            )}
          </div>
        ) : null}
      </div>
      {(offset > 0 || result.hasMore) && (
        <footer className="extension-pagination">
          <Button
            size="sm"
            variant="ghost"
            disabled={offset === 0 || loading || busy}
            onClick={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}
          >
            {copy.previous}
          </Button>
          <span>{Math.floor(offset / PAGE_SIZE) + 1}</span>
          <Button
            size="sm"
            variant="ghost"
            disabled={!result.hasMore || loading || busy}
            onClick={() => setOffset((value) => value + PAGE_SIZE)}
          >
            {copy.next}
          </Button>
        </footer>
      )}
    </>
  )
  return (
    <section className="extension-page" aria-label={copy[section]}>
      <header className="extension-page-heading">
        <div>
          <h1>{copy[section]}</h1>
          <p>{copy[`${section}Hint`]}</p>
        </div>
        <div className="extension-heading-actions">
          <Button size="sm" variant="secondary" onClick={() => setEditor({})}>
            <Plus size={15} />
            {copy.custom}
          </Button>
        </div>
      </header>
      <TabGroup
        selectedIndex={views.indexOf(view)}
        onChange={(index) => changeView(views[index])}
      >
        <TabList className="extension-views" aria-label={copy[section]}>
          {views.map((value) => (
            <Tab key={value} disabled={busy}>
              {copy[value]}
            </Tab>
          ))}
        </TabList>
        <TabPanels>
          {views.map((value) => (
            <TabPanel key={value}>{view === value ? content : null}</TabPanel>
          ))}
        </TabPanels>
      </TabGroup>
      <ExtensionDetails
        projectId={projectId}
        item={selected}
        busy={busy}
        onClose={() => setSelected(null)}
        onEdit={(detail) => {
          setSelected(null)
          setEditor({ detail })
        }}
        onInstall={(item) =>
          void act(
            () => extensionsApi.install(projectId, item),
            () => {
              setSelected(null)
              setNotice(copy.installedNotice)
            },
          )
        }
        onUninstall={(item) => {
          setSelected(null)
          setError('')
          setRemove(item)
        }}
      />
      {editor && (
        <CustomExtensionEditor
          projectId={projectId}
          initialKind={section}
          detail={editor.detail}
          onClose={() => setEditor(null)}
          onSaved={(kind) => {
            setEditor(null)
            if (section !== kind) onNavigate(kind)
            else showInstalled()
          }}
        />
      )}
      {showSources && (
        <ExtensionScanSettings
          projectId={projectId}
          kind={section}
          onClose={() => setShowSources(false)}
          onSaved={() => {
            setShowSources(false)
            setOffset(0)
            setRevision((value) => value + 1)
          }}
        />
      )}
      <AlertDialog
        open={Boolean(remove)}
        dismissible={!busy}
        onClose={() => {
          if (!busy) setRemove(null)
        }}
      >
        <DialogContainer>
          <DialogPanel className="sm:max-w-[420px]">
            <DialogHeader>
              <DialogTitle>{copy.removeTitle}</DialogTitle>
            </DialogHeader>
            <DialogBody>
              <p className="mb-2 text-sm font-medium">{remove?.name}</p>
              <p className="text-sm leading-6 text-muted-foreground">
                {copy.removeHint}
              </p>
              {error && (
                <p
                  role="alert"
                  data-error-toast="off"
                  className="extension-error"
                >
                  {error}
                </p>
              )}
            </DialogBody>
            <DialogFooter>
              <Button
                size="sm"
                variant="tertiary"
                disabled={busy}
                onClick={() => {
                  setRemove(null)
                  setError('')
                }}
              >
                {copy.cancel}
              </Button>
              <Button
                size="sm"
                variant="danger"
                pending={busy}
                onClick={() => {
                  if (remove)
                    void act(
                      () =>
                        extensionsApi.changeState(
                          projectId,
                          remove,
                          'uninstall',
                        ),
                      () => setRemove(null),
                    )
                }}
              >
                {copy.uninstall}
              </Button>
            </DialogFooter>
          </DialogPanel>
        </DialogContainer>
      </AlertDialog>
    </section>
  )
}
