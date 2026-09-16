import { Button, Modal, TextArea } from '@heroui/react'
import { AlertCircle, CheckCircle2, GitBranch, GitCommit, Sparkles } from 'lucide-react'
import { useEffect, useState } from 'react'
import { agentRuntimeApi, type SessionGitCommitResult } from '../../../lib/api/agentRuntime'
import { useLocale } from '../../../hooks/useLocale'

interface Props {
  isOpen: boolean
  sessionId: string | null
  branch: string
  changedFiles: number
  onClose: () => void
  onCommitted: (result: SessionGitCommitResult) => void
}

/**
 * Commit the session workspace on its current branch, optionally pushing it.
 *
 * Leaving the message empty asks the session's current model to write it —
 * that call happens on the server, so the dialog only sends what the user typed.
 */
export function SessionCommitDialog({
  isOpen,
  sessionId,
  branch,
  changedFiles,
  onClose,
  onCommitted,
}: Props) {
  const { t } = useLocale()
  const [message, setMessage] = useState('')
  const [submitting, setSubmitting] = useState<'commit' | 'push' | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<SessionGitCommitResult | null>(null)

  // Each open starts from a clean form instead of replaying the last attempt.
  useEffect(() => {
    if (!isOpen) return
    setMessage('')
    setError(null)
    setResult(null)
    setSubmitting(null)
  }, [isOpen])

  const run = async (push: boolean) => {
    if (!sessionId || submitting) return
    setSubmitting(push ? 'push' : 'commit')
    setError(null)
    try {
      const trimmed = message.trim()
      const committed = await agentRuntimeApi.commitSessionWorkspace(sessionId, {
        ...(trimmed ? { message: trimmed } : {}),
        ...(push ? {} : { push: false }),
      })
      setResult(committed)
      onCommitted(committed)
    } catch (err) {
      setError(
        err instanceof Error && err.message
          ? err.message
          : push
            ? t('workspaceCommitPush')
            : t('workspaceCommitOnly'),
      )
    } finally {
      setSubmitting(null)
    }
  }

  const handleOpenChange = (open: boolean) => {
    if (!open && !submitting) onClose()
  }

  const busy = submitting !== null
  const upstream = result?.upstream ?? branch
  const pushed = result?.pushed === true

  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={handleOpenChange}>
      <Modal.Container size="sm">
        <Modal.Dialog className="sm:max-w-lg">
          <Modal.CloseTrigger />
          <Modal.Header>
            <Modal.Icon className="bg-primary/10 text-primary">
              <GitCommit size={18} />
            </Modal.Icon>
            <Modal.Heading>{t('workspaceCommitTitle')}</Modal.Heading>
          </Modal.Header>
          <Modal.Body className="space-y-4">
            {result ? (
              <div
                role="status"
                className="flex items-start gap-3 rounded-lg border border-success/30 bg-success/[0.06] px-3 py-3"
              >
                <CheckCircle2 size={15} className="mt-0.5 shrink-0 text-success" />
                <div className="min-w-0 space-y-1.5">
                  <p className="text-xs leading-relaxed text-foreground/90">
                    {pushed
                      ? t('workspaceCommitSuccess', { sha: result.commitSha.slice(0, 8) })
                      : t('workspaceCommitLocalSuccess', { sha: result.commitSha.slice(0, 8) })}
                  </p>
                  {!pushed ? (
                    <p className="text-[10px] leading-relaxed text-muted-foreground">
                      {t('workspaceCommitLocalHint')}
                    </p>
                  ) : null}
                  <p className="flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
                    <GitBranch size={10} className="shrink-0" />
                    <span className="truncate font-mono">{upstream}</span>
                  </p>
                  <p
                    className="truncate font-mono text-[10px] leading-relaxed text-foreground/70"
                    title={result.message}
                  >
                    {result.message}
                  </p>
                </div>
              </div>
            ) : (
              <>
                {/* Target summary: which branch receives the commit, and how much is pending. */}
                <div className="flex items-center justify-between gap-3 rounded-lg border border-border/40 bg-secondary/40 px-3 py-2">
                  <span className="flex min-w-0 items-center gap-1.5 text-[11px]">
                    <GitBranch size={11} className="shrink-0 text-primary" />
                    <span className="truncate font-mono text-foreground/85" title={branch}>
                      {branch}
                    </span>
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {changedFiles > 0
                      ? t('workspaceCommitChangedFiles', { count: changedFiles })
                      : t('workspaceCommitNoChanges')}
                  </span>
                </div>

                <div className="space-y-1.5">
                  <div className="flex items-baseline justify-between gap-2">
                    <label
                      className="text-xs font-medium text-foreground/85"
                      htmlFor="session-commit-message"
                    >
                      {t('workspaceCommitMessageLabel')}
                    </label>
                    <span className="text-[10px] text-muted-foreground/70">
                      {t('workspaceCommitMessageOptional')}
                    </span>
                  </div>
                  <TextArea
                    id="session-commit-message"
                    aria-label={t('workspaceCommitMessageLabel')}
                    value={message}
                    onChange={event => setMessage(event.target.value)}
                    placeholder={t('workspaceCommitMessagePlaceholder')}
                    rows={4}
                    fullWidth
                    className="text-xs"
                  />
                  <p className="flex items-start gap-1.5 text-[11px] leading-relaxed text-muted-foreground">
                    <Sparkles size={11} className="mt-[3px] shrink-0 text-primary/70" />
                    <span>{t('workspaceCommitMessageHint')}</span>
                  </p>
                </div>

                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {t('workspaceCommitActionHint')}
                </p>

                {error ? (
                  <p
                    role="alert"
                    className="flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/5 px-3 py-2 text-[11px] leading-relaxed text-destructive"
                  >
                    <AlertCircle size={12} className="mt-[2px] shrink-0" />
                    <span className="min-w-0 break-words">{error}</span>
                  </p>
                ) : null}
              </>
            )}
          </Modal.Body>
          <Modal.Footer className="flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
            {result ? (
              <Button variant="primary" size="sm" onPress={onClose} className="sm:ml-auto">
                {t('workspaceCommitDone')}
              </Button>
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onPress={onClose}
                  isDisabled={busy}
                  className="sm:mr-auto"
                >
                  {t('workspaceCommitCancel')}
                </Button>
                <div className="flex items-center justify-end gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onPress={() => void run(false)}
                    isPending={submitting === 'commit'}
                    isDisabled={!sessionId || changedFiles === 0 || submitting === 'push'}
                  >
                    {t('workspaceCommitOnly')}
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    onPress={() => void run(true)}
                    isPending={submitting === 'push'}
                    isDisabled={!sessionId || changedFiles === 0 || submitting === 'commit'}
                  >
                    {t('workspaceCommitPush')}
                  </Button>
                </div>
              </>
            )}
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  )
}
