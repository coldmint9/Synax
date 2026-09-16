import { useEffect, useMemo, useState } from 'react'
import { ListBox, Popover, Tooltip } from '@heroui/react'
import { ChevronDown, GitBranch, LoaderCircle } from 'lucide-react'
import type { GitWorkspaceSelection } from '../../../lib/api/agentRuntime'
import { projectApi, type GitWorkspaceSummary } from '../../../lib/api/project'
import { useLocale } from '../../../hooks/useLocale'
import './agentControls.css'

interface Props {
  projectId: string
  value: GitWorkspaceSelection
  disabled: boolean
  onChange: (selection: GitWorkspaceSelection) => void
}

function selectionId(selection: GitWorkspaceSelection): string {
  if (selection.kind === 'default') return 'default'
  return selection.kind === 'branch' ? `branch:${selection.branch}` : `worktree:${selection.path}`
}

function selectionFromId(id: string): GitWorkspaceSelection | null {
  if (id === 'default') return { kind: 'default' }
  if (id.startsWith('branch:')) return { kind: 'branch', branch: id.slice('branch:'.length) }
  if (id.startsWith('worktree:')) return { kind: 'worktree', path: id.slice('worktree:'.length) }
  return null
}

export function GitWorkspacePicker({ projectId, value, disabled, onChange }: Props) {
  const { locale } = useLocale()
  const zh = locale === 'zh'
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [summary, setSummary] = useState<GitWorkspaceSummary | null>(null)

  useEffect(() => {
    let active = true
    setLoading(true)
    setSummary(null)
    projectApi.listGitWorkspaces(projectId)
      .then(result => { if (active) setSummary(result) })
      .catch(() => { if (active) setSummary(null) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [projectId])

  const options = useMemo(() => {
    if (!summary) return []
    const worktrees = summary.worktrees.map(item => ({
      id: `worktree:${item.path}`,
      label: item.branch ?? item.head.slice(0, 8),
      detail: item.path,
      meta: [
        item.primary ? (zh ? '主工作树' : 'Primary worktree') : (zh ? '工作树' : 'Worktree'),
        item.detached ? (zh ? '分离 HEAD' : 'Detached HEAD') : null,
        `HEAD ${item.head.slice(0, 12)}`,
        item.dirty ? (zh ? '有未提交修改' : 'Dirty') : null,
      ].filter(Boolean).join(' · '),
    }))
    const branches = summary.branches
      .filter(item => !item.checkedOutPath)
      .map(item => ({
        id: `branch:${item.name}`,
        label: item.name,
        detail: zh ? '创建托管工作树' : 'Create managed worktree',
        meta: [
          zh ? '分支' : 'Branch',
          `HEAD ${item.head.slice(0, 12)}`,
          item.upstream ? `${zh ? '上游' : 'Upstream'} ${item.upstream}` : null,
        ].filter(Boolean).join(' · '),
      }))
    return [
      {
        id: 'default',
        label: zh ? '项目默认工作区' : 'Project default',
        detail: summary.defaultPath,
        meta: zh ? '项目配置的默认目录' : 'Project configured default',
      },
      ...worktrees,
      ...branches,
    ]
  }, [summary, zh])

  if (!loading && !summary) return null
  const selectedId = selectionId(value)
  const selected = options.find(option => option.id === selectedId)
  const label = selected?.label ?? (zh ? '项目默认工作区' : 'Project default')

  return (
    <Popover isOpen={!disabled && open} onOpenChange={next => setOpen(!disabled && next)}>
      <Tooltip delay={400}>
        <Popover.Trigger<'button'>
          render={props => <button {...props} type="button" />}
          disabled={disabled || loading}
          aria-label={zh ? 'Git 工作区' : 'Git workspace'}
          className="goal-dock-composer-chip agent-mode-trigger"
        >
          {loading ? <LoaderCircle size={11} className="animate-spin" aria-hidden /> : <GitBranch size={11} aria-hidden />}
          <span>{label}</span>
          <ChevronDown size={10} aria-hidden />
        </Popover.Trigger>
        <Tooltip.Content>{zh ? '选择新会话使用的分支或工作树' : 'Choose the branch or worktree for this session'}</Tooltip.Content>
      </Tooltip>
      <Popover.Content placement="top end" offset={8} className="agent-mode-popover git-workspace-popover">
        <ListBox
          aria-label={zh ? 'Git 工作区' : 'Git workspace'}
          selectionMode="single"
          disallowEmptySelection
          selectedKeys={new Set([selectedId])}
          onSelectionChange={keys => {
            if (disabled || keys === 'all') return
            const next = selectionFromId(String([...keys][0]))
            if (next) { setOpen(false); onChange(next) }
          }}
        >
          {options.map(option => (
            <ListBox.Item key={option.id} id={option.id} textValue={option.label} className="agent-mode-option git-workspace-option">
              <div className="git-workspace-option-copy">
                <div className="git-workspace-option-label">{option.label}</div>
                <div className="git-workspace-option-meta">{option.meta}</div>
                <div className="git-workspace-option-detail" title={option.detail}>{option.detail}</div>
              </div>
              <ListBox.ItemIndicator />
            </ListBox.Item>
          ))}
        </ListBox>
      </Popover.Content>
    </Popover>
  )
}
