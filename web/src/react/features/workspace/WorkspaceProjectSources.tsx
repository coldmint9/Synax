import { useState, type Ref } from 'react'
import { Button, Input, Label, Tabs, TextField } from '@heroui/react'
import { Check, FolderOpen, Layers2, Plus, Search } from 'lucide-react'
import type { ProjectSummary } from '../../state/shellStore'
import { useWorkspaceCopy, workspacePathKey } from './workspaceCopy'
import './workspaceProjects.css'

const sourcePath = (project: ProjectSummary) => project.source?.kind === 'wsl'
  ? `${project.source.distribution ?? 'WSL'} · ${project.source.wslPath ?? ''}`
  : project.source?.localPath ?? ''

export function WorkspaceProjectSources({
  projects,
  loading,
  error,
  onRetry,
  disabled,
  paths,
  path,
  onPathChange,
  onBrowse,
  browseRef,
  onAddPath,
  onChoose,
  selectedId,
  mode,
  onModeChange
}: {
  projects: ProjectSummary[]
  loading: boolean
  error?: string | null
  onRetry: () => void
  disabled?: boolean
  paths: string[]
  path: string
  onPathChange: (path: string) => void
  onBrowse: () => void
  browseRef?: Ref<HTMLButtonElement>
  onAddPath?: () => void
  onChoose: (project: ProjectSummary) => void
  selectedId?: string
  mode: 'local' | 'existing'
  onModeChange: (mode: 'local' | 'existing') => void
}) {
  const c = useWorkspaceCopy()
  const [search, setSearch] = useState('')
  const query = search.trim().toLowerCase()
  const filtered = projects.filter((project) =>
    `${project.name} ${sourcePath(project)}`
      .toLowerCase()
      .includes(query)
  )
  const included = new Set(paths.map(workspacePathKey))
  const duplicate = Boolean(path.trim()) && included.has(workspacePathKey(path))
  return (
    <Tabs
      selectedKey={mode}
      onSelectionChange={(key) => onModeChange(key as 'local' | 'existing')}
      className="workspace-sources"
    >
      <Tabs.ListContainer className="workspace-source-tabs">
        <Tabs.List aria-label={c.sources}>
          <Tabs.Tab id="local" isDisabled={disabled}>
            <FolderOpen size={14} />
            {c.local}
            <Tabs.Indicator />
          </Tabs.Tab>
          <Tabs.Tab id="existing" isDisabled={disabled}>
            <Layers2 size={14} />
            {c.existing}
            <Tabs.Indicator />
          </Tabs.Tab>
        </Tabs.List>
      </Tabs.ListContainer>
      <Tabs.Panel id="local" className="workspace-source-panel">
        <Button
          ref={browseRef}
          variant="outline"
          className="workspace-browse"
          isDisabled={disabled}
          onPress={onBrowse}
          aria-label={c.browse}
        >
          <span className="workspace-project-icon workspace-project-icon--large">
            <FolderOpen size={23} strokeWidth={1.5} />
          </span>
          <span className="workspace-browse-title">{c.browseTitle}</span>
          <span className="workspace-hint">
            {onAddPath ? c.browseHint : c.singleBrowseHint}
          </span>
          <span className="workspace-browse-action">
            {c.browse}
            <Plus size={12} />
          </span>
        </Button>
        <TextField
          value={path}
          onChange={onPathChange}
          isDisabled={disabled}
          className="workspace-path-field"
        >
          <Label>{c.path}</Label>
          <div className="workspace-path-control">
            <Input
              placeholder="/path/to/project"
              spellCheck={false}
              onKeyDown={(event) => {
                if (
                  event.key === 'Enter' &&
                  onAddPath &&
                  !event.nativeEvent.isComposing
                ) {
                  event.preventDefault()
                  if (!duplicate) onAddPath()
                }
              }}
            />
            {onAddPath && (
              <Button
                size="sm"
                variant="secondary"
                isDisabled={disabled || !path.trim() || duplicate}
                onPress={onAddPath}
              >
                {c.add}
              </Button>
            )}
          </div>
        </TextField>
        {duplicate && <p className="workspace-hint">{c.duplicate}</p>}
      </Tabs.Panel>
      <Tabs.Panel id="existing" className="workspace-source-panel">
        <TextField
          value={search}
          onChange={setSearch}
          aria-label={c.search}
          isDisabled={disabled}
        >
          <div className="workspace-search">
            <Search size={14} />
            <Input aria-label={c.search} placeholder={c.search} />
          </div>
        </TextField>
        <p className="workspace-hint">{c.existingHint}</p>
        {error ? (
          <div className="workspace-feedback" role="alert">
            <span>{error}</span>
            <Button
              size="sm"
              variant="ghost"
              isDisabled={disabled}
              onPress={onRetry}
            >
              {c.retry}
            </Button>
          </div>
        ) : loading ? (
          <p className="workspace-hint" role="status">
            {c.loading}
          </p>
        ) : (
          <div className="workspace-existing-list" aria-label={c.existing}>
            {filtered.length === 0 && (
              <div className="workspace-search-empty">
                <Layers2 size={22} strokeWidth={1.4} />
                <p>{query ? c.noMatches : c.noProjects}</p>
              </div>
            )}
            {filtered.map((project) => {
              const added = included.has(
                workspacePathKey(sourcePath(project))
              )
              return (
                <Button
                  key={project.id}
                  variant="ghost"
                  className="workspace-existing-row"
                  isDisabled={disabled || added}
                  aria-pressed={selectedId === project.id}
                  onPress={() => onChoose(project)}
                >
                  <FolderOpen
                    size={16}
                    className="shrink-0 text-muted-foreground"
                  />
                  <span className="workspace-project-text">
                    <strong>{project.name}</strong>
                    <span title={sourcePath(project)}>
                      {sourcePath(project)}
                    </span>
                  </span>
                  {added ? (
                    <span className="workspace-added">
                      <Check size={12} />
                      {c.included}
                    </span>
                  ) : selectedId === project.id ? (
                    <Check size={15} />
                  ) : (
                    <Plus
                      size={14}
                      className="shrink-0 text-muted-foreground"
                    />
                  )}
                </Button>
              )
            })}
          </div>
        )}
      </Tabs.Panel>
    </Tabs>
  )
}
