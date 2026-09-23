import { useCallback, useEffect, useRef, useState } from 'react'
import {
  AlertDialog,
  Button,
  InputGroup,
  Spinner,
  TextField,
} from '@heroui/react'
import {
  Compass,
  Plus,
  RefreshCw,
  Search,
  SlidersHorizontal,
  X,
} from 'lucide-react'
import {
  extensionsApi,
  type ExtensionItem,
  type ExtensionKind,
  type ExtensionList,
  type ExtensionSource,
} from '../../../../lib/api/extensions'
import { AppSelect } from '../../../components/AppSelect'
import { ExtensionRow } from './ExtensionRow'
import { ExtensionDetails, type ExtensionDetail } from './ExtensionDetails'
import { CustomExtensionEditor } from './CustomExtensionEditor'
import { ExtensionSources } from './ExtensionSources'
import { useExtensionCopy } from './extension-copy'
import './extensions.css'

const PAGE_SIZE = 30
export function ExtensionCenter({
  projectId,
  section,
  onNavigate,
}: {
  projectId: string
  section: ExtensionKind | 'market'
  onNavigate: (section: ExtensionKind | 'market') => void
}) {
  const copy = useExtensionCopy()
  const market = section === 'market'
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [source, setSource] = useState('')
  const [type, setType] = useState('')
  const [offset, setOffset] = useState(0)
  const [revision, setRevision] = useState(0)
  const [sources, setSources] = useState<ExtensionSource[]>([])
  const [result, setResult] = useState<ExtensionList>({
    items: [],
    total: 0,
    hasMore: false,
    warnings: [],
  })
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
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
    const timer = window.setTimeout(() => {
      setDebounced(query.trim())
      setOffset(0)
      setRevision((value) => value + 1)
    }, 250)
    return () => window.clearTimeout(timer)
  }, [query])
  useEffect(() => {
    let active = true
    extensionsApi
      .sources(projectId)
      .then((value) => {
        if (active) setSources(value.items)
      })
      .catch((error) => {
        if (active) setError(error.message)
      })
    return () => {
      active = false
    }
  }, [projectId, showSources])
  const scope = JSON.stringify([
    projectId,
    section,
    source,
    type,
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
        view: market ? 'market' : 'installed',
        kind: market
          ? ((type || undefined) as ExtensionKind | undefined)
          : section,
        source: market ? source || undefined : undefined,
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
      setResult(next)
      setError('')
    } catch (error) {
      if (
        token === generation.current &&
        currentScope.current === scope &&
        mounted.current
      ) {
        setError(error instanceof Error ? error.message : 'Request failed')
        setResult({ items: [], total: 0, hasMore: false, warnings: [] })
      }
    } finally {
      if (
        token === generation.current &&
        currentScope.current === scope &&
        mounted.current
      )
        setLoading(false)
    }
  }, [
    projectId,
    section,
    market,
    type,
    source,
    query,
    debounced,
    offset,
    scope,
  ])
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
  const sourceName = (item: ExtensionSource) =>
    item.kind === 'builtin'
      ? copy.builtin
      : item.kind === 'local'
        ? copy.local
        : item.kind === 'custom'
          ? copy.custom
          : item.name
  const isSearching = Boolean(query.trim() || source || type)
  return (
    <section className="extension-page" aria-label={copy[section]}>
      <header className="extension-page-heading">
        <div>
          <h1>{copy[section]}</h1>
          <p>{copy[`${section}Hint`]}</p>
        </div>
        <div className="extension-heading-actions">
          {market && (
            <Button
              size="sm"
              variant="ghost"
              isIconOnly
              aria-label={copy.sources}
              onPress={() => setShowSources(true)}
            >
              <SlidersHorizontal size={16} />
            </Button>
          )}
          <Button size="sm" variant="secondary" onPress={() => setEditor({})}>
            <Plus size={15} />
            {copy.custom}
          </Button>
        </div>
      </header>
      <div className={`extension-toolbar${market ? ' is-market' : ''}`}>
        <TextField
          className="extension-search"
          aria-label={copy.search}
          value={query}
          onChange={(value) => {
            generation.current++
            setQuery(value)
            setLoading(true)
          }}
        >
          <InputGroup>
            <InputGroup.Prefix>
              <Search size={15} />
            </InputGroup.Prefix>
            <InputGroup.Input type="search" placeholder={copy.search} />
            {query && (
              <InputGroup.Suffix>
                <Button
                  size="sm"
                  variant="ghost"
                  isIconOnly
                  aria-label={copy.clear}
                  onPress={() => {
                    generation.current++
                    setQuery('')
                  }}
                >
                  <X size={13} />
                </Button>
              </InputGroup.Suffix>
            )}
          </InputGroup>
        </TextField>
        {market && (
          <>
            <AppSelect
              className="extension-filter"
              aria-label={copy.type}
              value={type}
              onChange={(value) => {
                setType(value ?? '')
                setOffset(0)
              }}
              options={[
                { key: '', label: copy.allKinds },
                ...(['tool', 'skill', 'mcp'] as const).map((key) => ({
                  key,
                  label: copy[key],
                })),
              ]}
            />
            <AppSelect
              className="extension-filter"
              aria-label={copy.source}
              value={source}
              onChange={(value) => {
                setSource(value ?? '')
                setOffset(0)
              }}
              options={[
                { key: '', label: copy.allSources },
                ...sources.map((item) => ({
                  key: item.id,
                  label: sourceName(item),
                })),
              ]}
            />
          </>
        )}
        <Button
          size="sm"
          variant="ghost"
          isIconOnly
          aria-label={copy.refresh}
          isDisabled={loading || busy}
          onPress={() => void reload()}
        >
          <RefreshCw size={15} />
        </Button>
      </div>
      {error && !remove && (
        <p role="alert" className="extension-error">
          {error}
        </p>
      )}
      {result.warnings.some((message) =>
        message.includes('at least 2 characters'),
      ) && (
        <p role="status" className="extension-form-note mb-3">
          {copy.searchLimit}
        </p>
      )}
      {result.warnings.some(
        (message) => !message.includes('at least 2 characters'),
      ) && (
        <details className="extension-notice">
          <summary>{copy.sourceError}</summary>
          {result.warnings
            .filter((message) => !message.includes('at least 2 characters'))
            .map((message, index) => (
              <p key={index}>{message}</p>
            ))}
        </details>
      )}
      <div className="extension-list-meta">
        <span>
          {market ? copy.market : copy.installed}
          {!loading &&
            ` · ${result.totalExact === false ? '≥ ' : ''}${result.total}`}
        </span>
        {loading && <Spinner size="sm" />}
      </div>
      <div aria-busy={loading}>
        {result.items.length > 0 ? (
          <ul>
            {result.items.map((item) => (
              <ExtensionRow
                key={`${item.kind}:${item.id}`}
                item={item}
                market={market}
                busy={busy || loading}
                onOpen={() => setSelected(item)}
                onInstall={() =>
                  void act(() => extensionsApi.install(projectId, item))
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
        ) : !loading && !error ? (
          <div className="extension-empty">
            <Compass
              size={26}
              strokeWidth={1.3}
              className="text-muted-foreground"
            />
            <h2>{isSearching ? copy.noResults : copy.empty}</h2>
            <p>{isSearching ? copy.noResultsHint : copy.emptyHint}</p>
            {!market && (
              <Button
                size="sm"
                variant="secondary"
                onPress={() => onNavigate('market')}
              >
                {copy.browse}
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
            isDisabled={offset === 0 || loading || busy}
            onPress={() => setOffset((value) => Math.max(0, value - PAGE_SIZE))}
          >
            {copy.previous}
          </Button>
          <span>{Math.floor(offset / PAGE_SIZE) + 1}</span>
          <Button
            size="sm"
            variant="ghost"
            isDisabled={!result.hasMore || loading || busy}
            onPress={() => setOffset((value) => value + PAGE_SIZE)}
          >
            {copy.next}
          </Button>
        </footer>
      )}
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
            () => setSelected(null),
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
          initialKind={market ? 'tool' : section}
          detail={editor.detail}
          onClose={() => setEditor(null)}
          onSaved={(kind) => {
            setEditor(null)
            if (section !== kind) onNavigate(kind)
            else void refresh.current()
          }}
        />
      )}
      {showSources && (
        <ExtensionSources
          projectId={projectId}
          onClose={() => setShowSources(false)}
          onChanged={() => void refresh.current()}
        />
      )}
      <AlertDialog.Backdrop
        isOpen={Boolean(remove)}
        isDismissable={!busy}
        isKeyboardDismissDisabled={busy}
        onOpenChange={(open) => {
          if (!open && !busy) setRemove(null)
        }}
      >
        <AlertDialog.Container>
          <AlertDialog.Dialog className="sm:max-w-[420px]">
            <AlertDialog.Header>
              <AlertDialog.Heading>{copy.removeTitle}</AlertDialog.Heading>
            </AlertDialog.Header>
            <AlertDialog.Body>
              <p className="mb-2 text-sm font-medium">{remove?.name}</p>
              <p className="text-sm leading-6 text-muted-foreground">
                {copy.removeHint}
              </p>
              {error && (
                <p role="alert" className="extension-error">
                  {error}
                </p>
              )}
            </AlertDialog.Body>
            <AlertDialog.Footer>
              <Button
                size="sm"
                variant="tertiary"
                isDisabled={busy}
                onPress={() => {
                  setRemove(null)
                  setError('')
                }}
              >
                {copy.cancel}
              </Button>
              <Button
                size="sm"
                variant="danger"
                isPending={busy}
                onPress={() => {
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
            </AlertDialog.Footer>
          </AlertDialog.Dialog>
        </AlertDialog.Container>
      </AlertDialog.Backdrop>
    </section>
  )
}
