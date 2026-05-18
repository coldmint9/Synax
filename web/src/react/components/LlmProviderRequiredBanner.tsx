import { AlertCircle, Settings } from 'lucide-react'
import { useNavigate } from 'react-router-dom'

const LLM_PROVIDER_NOT_CONFIGURED_CODE = 'LLM_PROVIDER_NOT_CONFIGURED'

export function isProviderNotConfiguredError(error: string | null | undefined): boolean {
  if (!error) return false
  return error.includes(LLM_PROVIDER_NOT_CONFIGURED_CODE) || error.includes('No LLM provider configured')
}

interface LlmProviderRequiredBannerProps {
  error: string | null | undefined
  onDismiss?: () => void
}

export function LlmProviderRequiredBanner({ error, onDismiss }: LlmProviderRequiredBannerProps) {
  const navigate = useNavigate()

  if (!isProviderNotConfiguredError(error)) return null

  return (
    <div className="flex items-center gap-2 border border-destructive/30 bg-destructive/10 rounded-md px-4 py-3 text-sm text-destructive">
      <AlertCircle size={16} className="shrink-0" />
      <span className="flex-1">未配置 LLM 服务商，无法执行此操作。请先前往设置页面配置 API Provider。</span>
      <button
        type="button"
        onClick={() => navigate('/settings')}
        className="inline-flex items-center gap-1 rounded px-2.5 py-1 text-xs font-medium bg-destructive/15 hover:bg-destructive/25 transition-colors"
      >
        <Settings size={12} />
        前往设置
      </button>
      {onDismiss && (
        <button
          type="button"
          onClick={onDismiss}
          className="shrink-0 rounded p-0.5 hover:bg-destructive/15 transition-colors"
          aria-label="关闭"
        >
          ×
        </button>
      )}
    </div>
  )
}
