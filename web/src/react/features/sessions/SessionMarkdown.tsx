import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import { memo, useCallback, useMemo } from 'react'
import remarkGfm from 'remark-gfm'
import { parseFileLink, type FileLinkTarget } from './fileLink'
import { FileTypeIcon } from './FileTypeIcon'
import { openWorkspaceFile } from './sessionWorkspaceStore'
import { useTranscriptSession } from './SessionTranscriptContext'

const REMARK_PLUGINS = [remarkGfm]

interface Props {
  content: string
  className?: string
}

/**
 * Anchors in agent replies point at workspace files far more often than at
 * URLs, and a bare `<a href="src/a.ts">` navigates the whole app away from the
 * session. Recognised file links open the workspace file viewer instead, while
 * real URLs keep the default anchor behaviour.
 */
function useMarkdownComponents(): Components {
  const { sessionId, workspacePath } = useTranscriptSession()

  const openTarget = useCallback((
    event: React.MouseEvent<HTMLAnchorElement>,
    target: FileLinkTarget,
  ) => {
    if (!sessionId || event.defaultPrevented) return
    event.preventDefault()
    openWorkspaceFile(sessionId, target.path, target.line)
  }, [sessionId])

  return useMemo(() => ({
    a({ href, children, ...props }) {
      const label = typeof children === 'string' ? children : undefined
      // A file link still renders as a file link without a session scope; it
      // simply keeps its href so nothing looks broken in isolated previews.
      const target = parseFileLink(href, label, workspacePath)

      if (!target) {
        return (
          <a {...props} href={href} target="_blank" rel="noreferrer noopener">
            {children}
          </a>
        )
      }

      return (
        <a
          {...props}
          href={href}
          title={target.line ? `${target.path}:${target.line}` : target.path}
          data-transcript-file-link={target.path}
          className="transcript-file-link"
          onClick={event => openTarget(event, target)}
        >
          <FileTypeIcon path={target.path} className="transcript-file-link-icon" />
          {children}
        </a>
      )
    },
  }), [openTarget, workspacePath])
}

export const SessionMarkdown = memo(function SessionMarkdown({ content, className = 'feed-prose' }: Props) {
  const components = useMarkdownComponents()
  return (
    <div className={`agent-conversation-copy ${className}`}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS} components={components}>
        {content}
      </ReactMarkdown>
    </div>
  )
})
