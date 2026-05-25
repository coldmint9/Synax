import { useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  ArrowLeft,
  ArrowRight,
  FolderOpen,
  GitBranch,
  Sparkles,
  Check,
  Loader2,
  FolderCode,
  Globe,
  AlertTriangle,
  RefreshCw,
  X,
} from 'lucide-react'
import { useShellStore, type ProjectSummary } from '../../state/shellStore'
import { projectApi, type DuplicateCheckResult } from '../../../lib/api/project'
import { apiFetch } from '../../../lib/api/origin'

type SourceKind = 'scratch' | 'localPath' | 'git'
type GitProvider = 'github' | 'gitlab'
type Step = 1 | 2 | 3

interface ProjectForm {
  sourceKind: SourceKind
  name: string
  environment: 'production' | 'staging' | 'development'
  localPath: string
  repoUrl: string
  branch: string
  commitSha: string
  gitProvider: GitProvider
}

const INITIAL_FORM: ProjectForm = {
  sourceKind: 'localPath',
  name: '',
  environment: 'development',
  localPath: '',
  repoUrl: '',
  branch: 'main',
  commitSha: '',
  gitProvider: 'github',
}

const SOURCE_OPTIONS: { kind: SourceKind; icon: typeof FolderOpen; title: string; desc: string }[] = [
  { kind: 'localPath', icon: FolderCode, title: '本地目录', desc: '分析本地代码目录' },
  { kind: 'git', icon: GitBranch, title: 'Git 仓库', desc: '从 GitHub/GitLab 克隆' },
  { kind: 'scratch', icon: Sparkles, title: '空白项目', desc: '从零开始构建' },
]

const GIT_PROVIDERS: { provider: GitProvider; label: string }[] = [
  { provider: 'github', label: 'GitHub' },
  { provider: 'gitlab', label: 'GitLab' },
]

const STEPS = ['选择来源', '配置信息', '确认导入']

interface ProjectCreateDialogProps {
  open: boolean
  onClose: () => void
}

export function ProjectCreateDialog({ open, onClose }: ProjectCreateDialogProps) {
  const navigate = useNavigate()
  const addProject = useShellStore(s => s.addProject)
  const [step, setStep] = useState<Step>(1)
  const [form, setForm] = useState<ProjectForm>(INITIAL_FORM)
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [duplicateCheck, setDuplicateCheck] = useState<DuplicateCheckResult | null>(null)
  const [checkingDuplicate, setCheckingDuplicate] = useState(false)
  const [overwriteMode, setOverwriteMode] = useState(false)

  const updateForm = useCallback(
    <K extends keyof ProjectForm>(key: K, value: ProjectForm[K]) => {
      setForm(prev => ({ ...prev, [key]: value }))
      setError(null)
    },
    [],
  )

  const canGoStep2 = form.sourceKind !== undefined
  const pathError = (() => {
    if (form.sourceKind === 'localPath') {
      const p = form.localPath.trim()
      if (!p) return '路径不能为空'
      if (!/^(\/|[A-Za-z]:\\|~\/)/.test(p)) return '请输入有效的绝对路径'
      return null
    }
    if (form.sourceKind === 'git') {
      const u = form.repoUrl.trim()
      if (!u) return 'URL 不能为空'
      try {
        const url = new URL(u)
        if (!['http:', 'https:', 'git:'].includes(url.protocol)) return '仅支持 http/https/git 协议'
      } catch {
        return '无效的 URL 格式'
      }
      return null
    }
    return null
  })()
  const canGoStep3 = pathError === null

  const autoName = useCallback(() => {
    if (form.name.trim()) return
    if (form.sourceKind === 'localPath' && form.localPath) {
      const parts = form.localPath.replace(/\\/g, '/').split('/').filter(Boolean)
      updateForm('name', parts[parts.length - 1] ?? 'Local Project')
    } else if (form.sourceKind === 'git' && form.repoUrl) {
      const parts = form.repoUrl.replace(/\.git$/, '').split('/').filter(Boolean)
      updateForm('name', parts[parts.length - 1] ?? 'Git Project')
    }
  }, [form, updateForm])

  const reset = () => {
    setStep(1)
    setForm(INITIAL_FORM)
    setError(null)
    setDuplicateCheck(null)
    setOverwriteMode(false)
  }

  const handleClose = () => {
    if (submitting) return
    reset()
    onClose()
  }

  const checkDuplicateBeforeSubmit = async (): Promise<boolean> => {
    if (form.sourceKind === 'scratch') return true
    setCheckingDuplicate(true)
    try {
      const result = await projectApi.checkDuplicate(
        form.sourceKind,
        form.sourceKind === 'git' ? form.repoUrl.trim() || undefined : undefined,
        form.sourceKind === 'localPath' ? form.localPath.trim() : undefined,
      )
      setCheckingDuplicate(false)
      if (result.exists) {
        setDuplicateCheck(result)
        return false
      }
      return true
    } catch {
      setCheckingDuplicate(false)
      return true
    }
  }

  const handleSubmit = async () => {
    if (submitting) return
    if (!overwriteMode) {
      const ok = await checkDuplicateBeforeSubmit()
      if (!ok) return
    }
    setSubmitting(true)
    setError(null)
    try {
      const resp = await apiFetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: form.name.trim(),
          environment: form.environment,
          source: {
            kind: form.sourceKind,
            repoUrl: form.sourceKind === 'git' ? form.repoUrl.trim() : undefined,
            branch: form.sourceKind === 'git' ? form.branch.trim() || 'main' : undefined,
            commitSha: form.sourceKind === 'git' && form.commitSha.trim() ? form.commitSha.trim() : undefined,
            localPath: form.sourceKind === 'localPath' ? form.localPath.trim() : undefined,
            provider: form.sourceKind === 'git' ? form.gitProvider : undefined,
          },
          overwriteExisting: overwriteMode,
        }),
      })
      if (!resp.ok) {
        const body = await resp.json().catch(() => ({ error: resp.statusText }))
        throw new Error(body.error || `HTTP ${resp.status}`)
      }
      const { project } = (await resp.json()) as { project: ProjectSummary & { source?: { kind: string; repoUrl?: string; branch?: string; localPath?: string } } }
      const apiSource = project.source as { kind: string; repoUrl?: string; branch?: string; localPath?: string } | undefined
      addProject({
        id: project.id,
        name: project.name,
        status: project.status ?? 'healthy',
        environment: project.environment ?? 'development',
        healthScore: project.healthScore ?? 0,
        activeAgents: 0,
        activeHumans: 1,
        openRisks: 0,
        updatedAt: 'just now',
        source: apiSource
          ? { kind: apiSource.kind === 'git' ? 'github' : apiSource.kind === 'localPath' ? 'localPath' : (apiSource.kind as 'scratch'), repo: apiSource.repoUrl, branch: apiSource.branch, localPath: apiSource.localPath }
          : { kind: 'scratch' },
        importState: form.sourceKind === 'scratch' ? 'ready' : 'syncing',
      })
      reset()
      onClose()
      navigate(`/projects/${project.id}/wiki`)
    } catch (err) {
      setError((err as Error).message || String(err))
    } finally {
      setSubmitting(false)
    }
  }

  const handleOverwrite = () => {
    setOverwriteMode(true)
    setDuplicateCheck(null)
    setTimeout(() => handleSubmit(), 0)
  }

  if (!open) return null

  return (
    <div className="dialog-overlay" onClick={handleClose}>
      <div
        className="dialog-content w-full max-w-lg"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between mb-4">
          <h2 className="text-base font-semibold text-foreground">导入项目</h2>
          <button type="button" className="flex h-6 w-6 items-center justify-center rounded-md text-muted-foreground hover:bg-secondary hover:text-foreground transition-colors" onClick={handleClose}>
            <X size={16} />
          </button>
        </div>

        {/* Step indicator */}
        <div className="flex items-center gap-2 mb-5">
          {STEPS.map((label, i) => {
            const idx = (i + 1) as Step
            const state = step > idx ? 'done' : step === idx ? 'active' : 'pending'
            return (
              <div key={i} className="flex items-center gap-2">
                <div
                  className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-medium ${
                    state === 'done'
                      ? 'bg-primary text-primary-foreground'
                      : state === 'active'
                        ? 'bg-primary/20 text-primary'
                        : 'bg-secondary text-muted-foreground'
                  }`}
                >
                  {state === 'done' ? <Check size={10} /> : idx}
                </div>
                <span className={`text-xs ${state === 'active' ? 'text-foreground font-medium' : 'text-muted-foreground'}`}>
                  {label}
                </span>
                {i < STEPS.length - 1 && <div className="h-px w-4 bg-border" />}
              </div>
            )
          })}
        </div>

        {/* Duplicate warning */}
        {duplicateCheck && !overwriteMode && (
          <div className="mb-4 rounded-lg border border-warning/30 bg-warning/5 p-3">
            <div className="flex items-start gap-2">
              <AlertTriangle size={14} className="shrink-0 text-warning mt-0.5" />
              <div className="flex-1">
                <p className="text-xs text-foreground font-medium">检测到重复导入</p>
                <p className="text-[11px] text-muted-foreground mt-0.5">{duplicateCheck.reason || '已存在相同来源的项目'}</p>
                <div className="mt-2 flex gap-2">
                  <button className="inline-flex items-center gap-1 rounded-md bg-warning px-2.5 py-1 text-[11px] font-medium text-warning-foreground" onClick={handleOverwrite}>
                    <RefreshCw size={11} /> 覆盖
                  </button>
                  <button className="inline-flex items-center rounded-md border border-border px-2.5 py-1 text-[11px] text-foreground" onClick={() => setDuplicateCheck(null)}>
                    取消
                  </button>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Step 1: Source selection */}
        {step === 1 && (
          <div className="space-y-2">
            {SOURCE_OPTIONS.map(opt => {
              const Icon = opt.icon
              const selected = form.sourceKind === opt.kind
              return (
                <button
                  key={opt.kind}
                  type="button"
                  className={`flex w-full items-center gap-3 rounded-lg border p-3 text-left transition ${selected ? 'border-primary bg-primary/5' : 'border-border/50 hover:bg-secondary/50'}`}
                  onClick={() => updateForm('sourceKind', opt.kind)}
                >
                  <div className={`flex h-8 w-8 items-center justify-center rounded-lg ${selected ? 'bg-primary/20 text-primary' : 'bg-secondary text-muted-foreground'}`}>
                    <Icon size={16} />
                  </div>
                  <div>
                    <div className="text-sm font-medium text-foreground">{opt.title}</div>
                    <div className="text-[11px] text-muted-foreground">{opt.desc}</div>
                  </div>
                  {selected && <Check size={14} className="ml-auto text-primary" />}
                </button>
              )
            })}
          </div>
        )}

        {/* Step 2: Configuration */}
        {step === 2 && (
          <div className="space-y-3">
            {form.sourceKind === 'localPath' && (
              <label className="block">
                <span className="mb-1 block text-xs font-medium text-foreground">本地目录路径 <span className="text-destructive">*</span></span>
                <input type="text" className={`import-input${pathError && form.localPath.trim() ? ' border-destructive' : ''}`} placeholder="/path/to/project" value={form.localPath} onChange={e => updateForm('localPath', e.target.value)} onBlur={autoName} />
                {pathError && form.localPath.trim() && <span className="mt-1 block text-[11px] text-destructive">{pathError}</span>}
              </label>
            )}
            {form.sourceKind === 'git' && (
              <>
                <div className="flex gap-2">
                  {GIT_PROVIDERS.map(gp => (
                    <button key={gp.provider} type="button" className={`flex-1 rounded-lg border px-3 py-1.5 text-xs font-medium transition ${form.gitProvider === gp.provider ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-secondary'}`} onClick={() => updateForm('gitProvider', gp.provider)}>
                      {gp.label}
                    </button>
                  ))}
                </div>
                <label className="block">
                  <span className="mb-1 block text-xs font-medium text-foreground">仓库 URL <span className="text-destructive">*</span></span>
                  <input type="text" className={`import-input${pathError && form.repoUrl.trim() ? ' border-destructive' : ''}`} placeholder="https://github.com/org/repo.git" value={form.repoUrl} onChange={e => updateForm('repoUrl', e.target.value)} onBlur={autoName} />
                  {pathError && form.repoUrl.trim() && <span className="mt-1 block text-[11px] text-destructive">{pathError}</span>}
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-foreground">分支</span>
                    <input type="text" className="import-input" placeholder="main" value={form.branch} onChange={e => updateForm('branch', e.target.value)} />
                  </label>
                  <label className="block">
                    <span className="mb-1 block text-xs font-medium text-foreground">提交 SHA</span>
                    <input type="text" className="import-input font-mono" placeholder="可选" value={form.commitSha} onChange={e => updateForm('commitSha', e.target.value)} />
                  </label>
                </div>
              </>
            )}
            <label className="block">
              <span className="mb-1 block text-xs font-medium text-foreground">项目名称</span>
              <input type="text" className="import-input" placeholder={form.sourceKind === 'scratch' ? '输入项目名称' : '留空自动推导'} value={form.name} onChange={e => updateForm('name', e.target.value)} />
            </label>
          </div>
        )}

        {/* Step 3: Confirm */}
        {step === 3 && (
          <div className="space-y-3">
            <div className="space-y-2 rounded-lg border border-border/40 bg-background/50 p-3 text-xs">
              <div className="flex justify-between"><span className="text-muted-foreground">项目名称</span><span className="text-foreground">{form.name || '-'}</span></div>
              <div className="flex justify-between"><span className="text-muted-foreground">来源</span><span className="text-foreground">{form.sourceKind === 'scratch' ? '空白' : form.sourceKind === 'localPath' ? '本地目录' : 'Git'}</span></div>
              {form.sourceKind === 'localPath' && <div className="flex justify-between"><span className="text-muted-foreground">路径</span><span className="text-foreground font-mono text-[11px] truncate max-w-[200px]">{form.localPath}</span></div>}
              {form.sourceKind === 'git' && <div className="flex justify-between"><span className="text-muted-foreground">仓库</span><span className="text-foreground font-mono text-[11px] truncate max-w-[200px]">{form.repoUrl}</span></div>}
              {form.sourceKind === 'git' && <div className="flex justify-between"><span className="text-muted-foreground">分支</span><span className="text-foreground">{form.branch || 'main'}</span></div>}
            </div>
            {form.sourceKind !== 'scratch' && (
              <div className="rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-[11px] text-primary">
                <Sparkles size={11} className="inline mr-1" />
                创建后将自动运行 Analyzer
              </div>
            )}
            {error && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">{error}</div>
            )}
          </div>
        )}

        {/* Navigation */}
        <div className="mt-5 flex items-center justify-between">
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-lg border border-border/50 bg-background/60 px-3 py-1.5 text-xs text-foreground transition hover:bg-background/90 disabled:opacity-40"
            onClick={() => { setStep(prev => Math.max(1, prev - 1) as Step); setDuplicateCheck(null); setOverwriteMode(false) }}
            disabled={step === 1 || submitting}
          >
            <ArrowLeft size={12} />
            上一步
          </button>
          {step < 3 ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-lg bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-40"
              onClick={() => {
                if (step === 1 && canGoStep2) setStep(2)
                else if (step === 2) {
                  if (!form.name.trim()) {
                    if (form.sourceKind === 'localPath' && form.localPath) {
                      const parts = form.localPath.replace(/\\/g, '/').split('/').filter(Boolean)
                      setForm(prev => ({ ...prev, name: parts[parts.length - 1] ?? 'Local Project' }))
                    } else if (form.sourceKind === 'git' && form.repoUrl) {
                      const parts = form.repoUrl.replace(/\.git$/, '').split('/').filter(Boolean)
                      setForm(prev => ({ ...prev, name: parts[parts.length - 1] ?? 'Git Project' }))
                    } else {
                      setForm(prev => ({ ...prev, name: 'New Project' }))
                    }
                  }
                  setStep(3)
                }
              }}
              disabled={step === 1 ? !canGoStep2 : !canGoStep3}
            >
              下一步
              <ArrowRight size={12} />
            </button>
          ) : (
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-lg bg-primary px-4 py-1.5 text-xs font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-40"
              onClick={handleSubmit}
              disabled={submitting || checkingDuplicate}
            >
              {submitting ? <><Loader2 size={12} className="animate-spin" /> 创建中…</> : <><Check size={12} /> {form.sourceKind === 'scratch' ? '创建' : '创建并分析'}</>}
            </button>
          )}
        </div>
      </div>
    </div>
  )
}
