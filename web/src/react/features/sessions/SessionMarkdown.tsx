import ReactMarkdown from 'react-markdown'
import { memo } from 'react'
import remarkGfm from 'remark-gfm'

const REMARK_PLUGINS = [remarkGfm]

interface Props {
  content: string
  className?: string
}

export const SessionMarkdown = memo(function SessionMarkdown({ content, className = 'feed-prose' }: Props) {
  return (
    <div className={className}>
      <ReactMarkdown remarkPlugins={REMARK_PLUGINS}>
        {content}
      </ReactMarkdown>
    </div>
  )
})
