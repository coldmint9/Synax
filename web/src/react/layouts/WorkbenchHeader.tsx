import { useState, useCallback } from 'react'
import { Tabs, Dropdown, Modal, Button, useOverlayState } from '@heroui/react'
import { BookOpen, Monitor, Search, Settings2, Sun, Moon, Zap, ChevronsUpDown, Plus, Trash2 } from 'lucide-react'
import { useShellStore, type ProjectSummary } from '../state/shellStore'
import { useWikiStore, type WikiViewMode } from '../state/wikiStore'
import type { ActivityPanel } from './ActivityBar'

interface WorkbenchHeaderProps {
  activePanel: ActivityPanel | null
  onPanelToggle: (panel: ActivityPanel) => void
  hasProject: boolean
  projectName: string
  currentProjectId: string
  projects: ProjectSummary[]
  onProjectSwitch: (projectId: string) => void
  onCreateProject: () => void
  onRemoveProject: (projectId: string) => Promise<void>
}

const navTabs: { id: ActivityPanel; icon: typeof BookOpen; label: string }[] = [
  { id: 'wiki', icon: BookOpen, label: 'Wiki' },
  { id: 'sessions', icon: Monitor, label: 'Sessions' },
]

function WikiToolbar() {
  const viewMode = useWikiStore(s => s.viewMode)
  const setViewMode = useWikiStore(s => s.setViewMode)
  const patchesPending = useWikiStore(s => s.patchesSummary.pending)
  const togglePatchPanel = useWikiStore(s => s.togglePatchPanel)
  const planGenStatus = useWikiStore(s => s.planGeneration.status)

  return (
    <div className="flex items-center gap-0.5">
      <Tabs
        selectedKey={viewMode}
        onSelectionChange={(key) => setViewMode(key as WikiViewMode)}
        className="wiki-view-tabs"
      >
        <Tabs.ListContainer>
          <Tabs.List aria-label="Wiki 视图" className="wiki-view-tabs-list">
            <Tabs.Tab id="document" className="wiki-view-tab">
              <span>文档</span>
              <Tabs.Indicator />
            </Tabs.Tab>
            <Tabs.Tab id="plan" className="wiki-view-tab">
              <span>规划</span>
              {planGenStatus === 'generating' && (
                <span className="relative flex h-2 w-2 ml-0.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-primary/60" />
                  <span className="relative inline-flex h-2 w-2 rounded-full bg-primary" />
                </span>
              )}
              <Tabs.Indicator />
            </Tabs.Tab>
          </Tabs.List>
        </Tabs.ListContainer>
      </Tabs>
      <div className="wh-divider" />
      <button type="button" className="wh-btn relative" title="Patches" onClick={togglePatchPanel}>
        <Zap size={13} />
        {patchesPending > 0 && (
          <span className="absolute -top-0.5 -right-0.5 flex h-3.5 min-w-3.5 items-center justify-center rounded-full bg-warning px-0.5 text-[8px] font-bold text-warning-foreground">
            {patchesPending}
          </span>
        )}
      </button>
      <button type="button" className="wh-btn" title="搜索">
        <Search size={13} />
      </button>
    </div>
  )
}

export function WorkbenchHeader({
  activePanel,
  onPanelToggle,
  hasProject,
  projectName,
  currentProjectId,
  projects,
  onProjectSwitch,
  onCreateProject,
  onRemoveProject,
}: WorkbenchHeaderProps) {
  const theme = useShellStore(s => s.preferences.theme)
  const setTheme = useShellStore(s => s.setTheme)

  const confirmState = useOverlayState()
  const [deleteTarget, setDeleteTarget] = useState<ProjectSummary | null>(null)
  const [deleting, setDeleting] = useState(false)

  const handleRemoveClick = useCallback((e: React.MouseEvent, project: ProjectSummary) => {
    e.stopPropagation()
    setDeleteTarget(project)
    confirmState.open()
  }, [confirmState])

  const handleConfirmRemove = useCallback(async () => {
    if (!deleteTarget || deleting) return
    setDeleting(true)
    try {
      await onRemoveProject(deleteTarget.id)
      confirmState.close()
      setDeleteTarget(null)
    } finally {
      setDeleting(false)
    }
  }, [deleteTarget, deleting, onRemoveProject, confirmState])

  return (
    <div className="workbench-header">
      <div className="wh-pill">
        <Dropdown>
          <Dropdown.Trigger>
            <button type="button" className="wh-project-trigger">
              <span className="truncate max-w-[120px] text-xs font-medium">
                {hasProject ? projectName : 'Synapse'}
              </span>
              <ChevronsUpDown size={12} className="text-muted-foreground shrink-0" />
            </button>
          </Dropdown.Trigger>
          <Dropdown.Popover placement="top start">
            <Dropdown.Menu
              aria-label="切换项目"
              onAction={(key) => {
                if (key === '__create__') onCreateProject()
                else onProjectSwitch(key as string)
              }}
            >
              {projects.map(p => (
                <Dropdown.Item key={p.id} id={p.id} textValue={p.name}>
                  <div className="flex items-center justify-between w-full gap-2">
                    <span className="text-xs truncate">{p.name}</span>
                    <button
                      type="button"
                      className="shrink-0 p-0.5 rounded text-muted-foreground/50 hover:text-destructive hover:bg-destructive/10 transition"
                      onClick={(e) => handleRemoveClick(e, p)}
                    >
                      <Trash2 size={11} />
                    </button>
                  </div>
                </Dropdown.Item>
              ))}
              <Dropdown.Item key="__create__" id="__create__" textValue="导入项目">
                <span className="flex items-center gap-1.5 text-xs text-primary">
                  <Plus size={12} />
                  导入项目
                </span>
              </Dropdown.Item>
            </Dropdown.Menu>
          </Dropdown.Popover>
        </Dropdown>

        <div className="wh-divider" />

        <Tabs
          selectedKey={activePanel ?? ''}
          onSelectionChange={(key) => onPanelToggle(key as ActivityPanel)}
          className="wh-tabs"
        >
          <Tabs.ListContainer>
            <Tabs.List aria-label="主导航" className="wh-tabs-list">
              {navTabs.map((tab, i) => {
                const Icon = tab.icon
                return (
                  <Tabs.Tab
                    key={tab.id}
                    id={tab.id}
                    isDisabled={!hasProject}
                    className="wh-tab"
                  >
                    {i > 0 && <Tabs.Separator />}
                    <Icon size={13} />
                    <span>{tab.label}</span>
                    <Tabs.Indicator />
                  </Tabs.Tab>
                )
              })}
            </Tabs.List>
          </Tabs.ListContainer>
        </Tabs>

        <div className="wh-divider" />

        <div className="wh-actions">
          <button type="button" className="wh-btn" title="设置" onClick={() => onPanelToggle('settings')}>
            <Settings2 size={15} />
          </button>
          <button
            type="button"
            className="wh-btn"
            title={theme === 'dark' ? '浅色模式' : '深色模式'}
            onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}
          >
            {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          </button>
        </div>
      </div>

      {activePanel === 'wiki' && (
        <div className="wh-pill">
          <WikiToolbar />
        </div>
      )}

      {/* Remove project confirmation modal */}
      <Modal state={confirmState}>
        <Modal.Backdrop>
          <Modal.Container size="sm">
            <Modal.Dialog>
              <Modal.Header>
                <Modal.Icon className="bg-destructive/10 text-destructive">
                  <Trash2 size={18} />
                </Modal.Icon>
                <Modal.Heading>移除项目</Modal.Heading>
              </Modal.Header>
              <Modal.Body>
                <p className="text-sm text-muted-foreground">
                  确定要移除「{deleteTarget?.name}」吗？项目配置和元数据将被永久删除，此操作不可撤销。
                </p>
                {deleteTarget?.id === currentProjectId && (
                  <p className="mt-2 text-xs text-warning">
                    该项目正在运行中，移除前将自动关闭并中断所有连接。
                  </p>
                )}
              </Modal.Body>
              <Modal.Footer>
                <Button
                  variant="ghost"
                  size="sm"
                  isDisabled={deleting}
                  onPress={() => { confirmState.close(); setDeleteTarget(null) }}
                >
                  取消
                </Button>
                <Button
                  variant="danger"
                  size="sm"
                  isDisabled={deleting}
                  onPress={() => void handleConfirmRemove()}
                >
                  {deleting ? '移除中…' : '确认移除'}
                </Button>
              </Modal.Footer>
            </Modal.Dialog>
          </Modal.Container>
        </Modal.Backdrop>
      </Modal>
    </div>
  )
}
