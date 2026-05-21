import { useState, useCallback } from 'react'
import { useNavigate, Link } from 'react-router-dom'
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

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Source cards config
// ---------------------------------------------------------------------------

const SOURCE_OPTIONS: { kind: SourceKind; icon: typeof FolderOpen; title: string; desc: string }[] = [
  {
    kind: 'localPath',
    icon: FolderCode,
    title: '本地目录',
    desc: '分析本地代码目录，构建项目图谱',
  },
  {
    kind: 'git',
    icon: GitBranch,
    title: 'Git 仓库',
    desc: '从 GitHub/GitLab 克隆并自动运行分析',
  },
  {
    kind: 'scratch',
    icon: Sparkles,
    title: '空白项目',
    desc: '从零开始，手动构建协调图',
  },
]

const GIT_PROVIDERS: { provider: GitProvider; label: string; icon: typeof Globe; color: string }[] = [
  { provider: 'github', label: 'GitHub', icon: Globe, color: 'text-foreground' },
  { provider: 'gitlab', label: 'GitLab', icon: Globe, color: 'text-foreground' },
]

// ---------------------------------------------------------------------------
// Step indicator config
// ---------------------------------------------------------------------------

const STEPS: { label: string; desc: string }[] = [
  { label: '选择来源', desc: '选择项目代码来源' },
  { label: '配置信息', desc: '填写项目名称与参数' },
  { label: '确认导入', desc: '检查并启动分析' },
]

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export default function ProjectCreatePage() {
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

  // ── Step validation ──

  const canGoStep2 = form.sourceKind !== undefined
  const canGoStep3 = (() => {
    if (form.sourceKind === 'localPath' && !form.localPath.trim()) return false
    if (form.sourceKind === 'git' && !form.repoUrl.trim()) return false
    return true
  })()

  // Derive name from path / url if empty
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

  // Check duplicate before submission
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
      return true // proceed on error
    }
  }

  // ── Submit ──

  const handleSubmit = async () => {
    if (submitting) return

    // Check duplicates first if not in overwrite mode
    if (!overwriteMode) {
      const ok = await checkDuplicateBeforeSubmit()
      if (!ok) return
    }

    setSubmitting(true)
    setError(null)

    try {
      const resp = await fetch('/api/projects', {
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
        if (resp.status === 409 && body.duplicate) {
          throw Object.assign(new Error(body.duplicate.reason || 'Duplicate'), { duplicate: body.duplicate, code: body.code })
        }
        throw new Error(body.error || `HTTP ${resp.status}`)
      }

      const { project } = (await resp.json()) as {
        project: ProjectSummary & { source?: { kind: string; repoUrl?: string; branch?: string; localPath?: string } }
      }
      const apiSource = project.source as
        | { kind: string; repoUrl?: string; branch?: string; localPath?: string }
        | undefined

      // Add to shell store
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
          ? {
              kind:
                apiSource.kind === 'git'
                  ? 'github'
                  : apiSource.kind === 'localPath'
                    ? 'localPath'
                    : (apiSource.kind as 'scratch'),
              repo: apiSource.repoUrl,
              branch: apiSource.branch,
              localPath: apiSource.localPath,
            }
          : { kind: 'scratch' },
        importState: form.sourceKind === 'scratch' ? 'ready' : 'syncing',
      })

      // Navigate to coordinates page
      const searchParams = new URLSearchParams()
      if (form.sourceKind !== 'scratch') {
        searchParams.set('autoAnalyze', '1')
        if (form.sourceKind === 'localPath') {
          searchParams.set('localPath', form.localPath.trim())
        } else if (form.sourceKind === 'git') {
          searchParams.set('repoUrl', form.repoUrl.trim())
          searchParams.set('branch', form.branch.trim() || 'main')
          if (form.commitSha.trim()) searchParams.set('commitSha', form.commitSha.trim())
        }
      }
      const qs = searchParams.toString()
      navigate(`/projects/${project.id}/coordinates${qs ? `?${qs}` : ''}`)
    } catch (err) {
      const e = err as Error & { duplicate?: Record<string, unknown>; code?: string }
      if (e.code === 'DUPLICATE_SOURCE' && e.duplicate) {
        setError(null) // handled by duplicate dialog
        setDuplicateCheck({
          exists: true,
          existingId: e.duplicate.existingId as string,
          existingName: e.duplicate.existingName as string,
          reason: e.duplicate.reason as string,
        })
      } else {
        setError(e.message || String(err))
      }
    } finally {
      setSubmitting(false)
    }
  }

  // Overwrite and resubmit
  const handleOverwrite = () => {
    setOverwriteMode(true)
    setDuplicateCheck(null)
    // Trigger submit on next render cycle
    setTimeout(() => {
      handleSubmit()
    }, 0)
  }

  // ── Render ──

  return (
    <div className="h-full overflow-auto bg-background">
      <div className="mx-auto flex min-h-full max-w-4xl flex-col px-6 py-10">
        {/* Header */}
        <div className="mb-8">
          <Link
            to="/"
            className="mb-4 inline-flex items-center gap-1.5 text-xs text-muted-foreground transition hover:text-foreground"
          >
            <ArrowLeft size={14} />
            返回首页
          </Link>
          <h1 className="text-2xl font-semibold tracking-tight text-foreground">
            导入项目
          </h1>
          <p className="mt-1 text-sm text-muted-foreground">
            选择代码来源，Synapse 将自动分析并构建项目协调图谱
          </p>
        </div>

        {/* Duplicate detection dialog (in-content) */}
        {duplicateCheck && !overwriteMode && (
          <div className="mb-6 animate-fade-up">
            <div className="rounded-xl border border-warning/30 bg-warning/6 p-5">
              <div className="flex items-start gap-3">
                <div className="duplicate-warning-icon">
                  <AlertTriangle size={16} />
                </div>
                <div className="flex-1">
                  <h3 className="text-sm font-semibold text-foreground">检测到重复导入</h3>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {duplicateCheck.reason || '已存在相同来源的项目'}
                  </p>
                  <div className="mt-4 flex items-center gap-2">
                    <button
                      className="inline-flex items-center gap-1.5 rounded-lg bg-warning px-4 py-2 text-xs font-medium text-warning-foreground hover:bg-warning/90 transition"
                      onClick={handleOverwrite}
                    >
                      <RefreshCw size={13} />
                      覆盖现有项目
                    </button>
                    <button
                      className="inline-flex items-center gap-1.5 rounded-lg border border-border/50 bg-background/60 px-4 py-2 text-xs text-foreground hover:bg-background/90 transition"
                      onClick={() => setDuplicateCheck(null)}
                    >
                      <X size={13} />
                      取消
                    </button>
                  </div>
                  <p className="mt-2 text-[10px] text-muted-foreground/60">
                    覆盖将删除旧项目并保留项目 ID，重新执行导入流程。
                  </p>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* Main layout: step sidebar + content */}
        <div className="flex flex-1 gap-10">
          {/* Step sidebar */}
          <div className="flex w-44 shrink-0 flex-col pt-1">
            {STEPS.map((s, i) => {
              const idx = (i + 1) as Step
              const state = step > idx ? 'done' : step === idx ? 'active' : 'pending'
              return (
                <div key={i} className="flex items-start gap-3">
                  <div className="flex flex-col items-center">
                    <div className="import-step-dot" data-state={state}>
                      {state === 'done' ? <Check size={12} /> : idx}
                    </div>
                    {i < STEPS.length - 1 && (
                      <div
                        className="import-step-line"
                        data-state={step > idx ? 'done' : 'pending'}
                      />
                    )}
                  </div>
                  <div className="pb-6">
                    <div
                      className={`text-sm font-medium ${
                        state === 'active'
                          ? 'text-foreground'
                          : state === 'done'
                            ? 'text-primary'
                            : 'text-muted-foreground'
                      }`}
                    >
                      {s.label}
                    </div>
                    <div className="text-[11px] text-muted-foreground/70">{s.desc}</div>
                  </div>
                </div>
              )
            })}
          </div>

          {/* Content area */}
          <div className="flex-1">
            <div className="rounded-xl border border-border/60 bg-card p-6">
              {/* Step 1: Source selection */}
              {step === 1 && (
                <div className="animate-fade-up">
                  <h2 className="mb-1 text-base font-medium text-foreground">
                    选择代码来源
                  </h2>
                  <p className="mb-5 text-xs text-muted-foreground">
                    指定项目的代码来源类型
                  </p>
                  <div className="grid gap-3">
                    {SOURCE_OPTIONS.map(opt => {
                      const Icon = opt.icon
                      const selected = form.sourceKind === opt.kind
                      return (
                        <button
                          key={opt.kind}
                          className="import-source-card text-left"
                          data-selected={selected}
                          onClick={() => updateForm('sourceKind', opt.kind)}
                        >
                          <div className="flex items-center gap-2.5">
                            <div
                              className={`flex h-8 w-8 items-center justify-center rounded-lg transition ${
                                selected
                                  ? 'bg-primary/20 text-primary'
                                  : 'bg-secondary text-muted-foreground'
                              }`}
                            >
                              <Icon size={16} />
                            </div>
                            <div>
                              <div className="text-sm font-medium text-foreground">
                                {opt.title}
                              </div>
                              <div className="text-xs text-muted-foreground">
                                {opt.desc}
                              </div>
                            </div>
                          </div>
                          {selected && (
                            <div className="absolute right-3 top-3 flex h-5 w-5 items-center justify-center rounded-full bg-primary text-primary-foreground">
                              <Check size={12} />
                            </div>
                          )}
                        </button>
                      )
                    })}
                  </div>
                </div>
              )}

              {/* Step 2: Configuration */}
              {step === 2 && (
                <div className="animate-fade-up">
                  <h2 className="mb-1 text-base font-medium text-foreground">
                    项目配置
                  </h2>
                  <p className="mb-5 text-xs text-muted-foreground">
                    填写项目基本信息
                    {form.sourceKind === 'localPath' && '和本地路径'}
                    {form.sourceKind === 'git' && '、仓库地址和 Git 提供者'}
                  </p>
                  <div className="grid gap-4">
                    {/* Source-specific fields first */}
                    {form.sourceKind === 'localPath' && (
                      <label className="block">
                        <span className="mb-1.5 block text-xs font-medium text-foreground">
                          本地目录路径 <span className="text-destructive">*</span>
                        </span>
                        <input
                          type="text"
                          className="import-input"
                          placeholder="例如：C:\Users\dev\my-project 或 /home/dev/my-project"
                          value={form.localPath}
                          onChange={e => updateForm('localPath', e.target.value)}
                          onBlur={autoName}
                        />
                        <span className="mt-1 block text-[11px] text-muted-foreground/60">
                          analyzer 将扫描此目录下的所有源码文件
                        </span>
                      </label>
                    )}

                    {form.sourceKind === 'git' && (
                      <>
                        {/* Git provider */}
                        <div>
                          <span className="mb-1.5 block text-xs font-medium text-foreground">
                            Git 提供者
                          </span>
                          <div className="grid grid-cols-2 gap-2">
                            {GIT_PROVIDERS.map(gp => {
                              const Icon = gp.icon
                              return (
                                <button
                                  key={gp.provider}
                                  className="provider-card text-left"
                                  data-selected={form.gitProvider === gp.provider}
                                  onClick={() => updateForm('gitProvider', gp.provider)}
                                >
                                  <div className="flex items-center gap-2">
                                    <Icon size={14} className={gp.color} />
                                    <span className="text-xs font-medium text-foreground">{gp.label}</span>
                                  </div>
                                </button>
                              )
                            })}
                          </div>
                        </div>

                        {/* Repo URL */}
                        <label className="block">
                          <span className="mb-1.5 block text-xs font-medium text-foreground">
                            仓库 URL <span className="text-destructive">*</span>
                          </span>
                          <input
                            type="text"
                            className="import-input"
                            placeholder={form.gitProvider === 'github'
                              ? 'https://github.com/org/repo.git'
                              : 'https://gitlab.com/org/repo.git'}
                            value={form.repoUrl}
                            onChange={e => updateForm('repoUrl', e.target.value)}
                            onBlur={autoName}
                          />
                        </label>

                        {/* Branch */}
                        <div className="grid grid-cols-2 gap-3">
                          <label className="block">
                            <span className="mb-1.5 block text-xs font-medium text-foreground">
                              分支
                            </span>
                            <input
                              type="text"
                              className="import-input"
                              placeholder="main"
                              value={form.branch}
                              onChange={e => updateForm('branch', e.target.value)}
                            />
                          </label>

                          {/* Commit SHA */}
                          <label className="block">
                            <span className="mb-1.5 block text-xs font-medium text-foreground">
                              提交 SHA
                            </span>
                            <input
                              type="text"
                              className="import-input font-mono"
                              placeholder="可选，固定到特定提交"
                              value={form.commitSha}
                              onChange={e => updateForm('commitSha', e.target.value)}
                            />
                          </label>
                        </div>
                      </>
                    )}

                    {/* Common fields */}
                    <label className="block">
                      <span className="mb-1.5 block text-xs font-medium text-foreground">
                        项目名称 <span className="text-destructive">*</span>
                      </span>
                      <input
                        type="text"
                        className="import-input"
                        placeholder={
                          form.sourceKind === 'scratch'
                            ? '输入项目名称'
                            : '留空将自动从路径/URL推导'
                        }
                        value={form.name}
                        onChange={e => updateForm('name', e.target.value)}
                      />
                    </label>

                    <label className="block">
                      <span className="mb-1.5 block text-xs font-medium text-foreground">
                        环境
                      </span>
                      <select
                        className="import-select"
                        value={form.environment}
                        onChange={e => updateForm('environment', e.target.value as ProjectForm['environment'])}
                      >
                        <option value="development">Development（开发）</option>
                        <option value="staging">Staging（预发布）</option>
                        <option value="production">Production（生产）</option>
                      </select>
                      <span className="mt-1 block text-[11px] text-muted-foreground/60">
                        选择此项目的目标环境，用于配置隔离和健康监控
                      </span>
                    </label>
                  </div>
                </div>
              )}

              {/* Step 3: Confirm */}
              {step === 3 && (
                <div className="animate-fade-up">
                  <h2 className="mb-1 text-base font-medium text-foreground">
                    确认导入
                  </h2>
                  <p className="mb-5 text-xs text-muted-foreground">
                    检查以下信息，确认后将创建项目
                    {form.sourceKind !== 'scratch' && '并自动启动代码分析'}
                  </p>

                  {/* Summary */}
                  <div className="space-y-3 rounded-lg border border-border/40 bg-background/50 p-4">
                    <SummaryRow label="项目名称" value={form.name} />
                    <SummaryRow
                      label="来源类型"
                      value={
                        form.sourceKind === 'scratch'
                          ? '空白项目'
                          : form.sourceKind === 'localPath'
                            ? '本地目录'
                            : 'Git 仓库'
                      }
                    />
                    {form.sourceKind === 'localPath' && (
                      <SummaryRow label="路径" value={form.localPath} mono />
                    )}
                    {form.sourceKind === 'git' && (
                      <>
                        <SummaryRow label="仓库" value={form.repoUrl} mono />
                        <SummaryRow label="分支" value={form.branch || 'main'} mono />
                        {form.commitSha && (
                          <SummaryRow label="提交" value={form.commitSha.slice(0, 7)} mono />
                        )}
                        <SummaryRow label="提供者" value={form.gitProvider === 'github' ? 'GitHub' : 'GitLab'} />
                      </>
                    )}
                    <SummaryRow label="环境" value={form.environment} />
                  </div>

                  {form.sourceKind !== 'scratch' && (
                    <div className="mt-4 rounded-lg border border-primary/20 bg-primary/5 px-4 py-3">
                      <div className="flex items-center gap-2 text-xs text-primary">
                        <Sparkles size={13} />
                        <span className="font-medium">创建后将自动运行 Analyzer 管线</span>
                      </div>
                      <p className="mt-1 text-[11px] text-muted-foreground">
                        包括 AST 解析、图谱构建、关键词索引、语义分析等阶段，进度将在 Coordinates 画布上实时展示
                      </p>
                    </div>
                  )}

                  {checkingDuplicate && (
                    <div className="mt-4 rounded-lg border border-border/40 bg-card/60 px-4 py-3 text-xs text-muted-foreground">
                      <Loader2 size={12} className="inline animate-spin mr-2" />
                      检查重复项目…
                    </div>
                  )}

                  {error && (
                    <div className="mt-4 rounded-lg border border-destructive/30 bg-destructive/5 px-4 py-3 text-xs text-destructive">
                      {error}
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Navigation buttons */}
            <div className="mt-5 flex items-center justify-between">
              <button
                className="inline-flex items-center gap-1.5 rounded-lg border border-border/50 bg-background/60 px-4 py-2 text-xs text-foreground transition hover:bg-background/90 disabled:opacity-40"
                onClick={() => {
                  setStep(prev => Math.max(1, prev - 1) as Step)
                  setDuplicateCheck(null)
                  setOverwriteMode(false)
                }}
                disabled={step === 1 || submitting}
              >
                <ArrowLeft size={13} />
                上一步
              </button>

              {step < 3 ? (
                <button
                  className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-5 py-2 text-xs font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-40"
                  onClick={() => {
                    if (step === 1 && canGoStep2) setStep(2)
                    else if (step === 2) {
                      let derivedName = form.name.trim()
                      if (!derivedName) {
                        if (form.sourceKind === 'localPath' && form.localPath) {
                          const parts = form.localPath.replace(/\\/g, '/').split('/').filter(Boolean)
                          derivedName = parts[parts.length - 1] ?? 'Local Project'
                        } else if (form.sourceKind === 'git' && form.repoUrl) {
                          const parts = form.repoUrl.replace(/\.git$/, '').split('/').filter(Boolean)
                          derivedName = parts[parts.length - 1] ?? 'Git Project'
                        } else {
                          derivedName = 'New Project'
                        }
                        setForm(prev => ({ ...prev, name: derivedName }))
                      }
                      setStep(3)
                    }
                  }}
                  disabled={step === 1 ? !canGoStep2 : !canGoStep3}
                >
                  下一步
                  <ArrowRight size={13} />
                </button>
              ) : (
                <button
                  className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-5 py-2 text-xs font-medium text-primary-foreground transition hover:bg-primary/90 disabled:opacity-40"
                  onClick={handleSubmit}
                  disabled={submitting || checkingDuplicate}
                >
                  {submitting ? (
                    <>
                      <Loader2 size={13} className="animate-spin" />
                      创建中…
                    </>
                  ) : (
                    <>
                      <Check size={13} />
                      {form.sourceKind === 'scratch' ? '创建项目' : '创建并分析'}
                    </>
                  )}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Summary row helper
// ---------------------------------------------------------------------------

function SummaryRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex items-center justify-between text-xs">
      <span className="text-muted-foreground">{label}</span>
      <span className={`text-foreground ${mono ? 'font-mono text-[11px]' : ''}`}>
        {value || '-'}
      </span>
    </div>
  )
}
