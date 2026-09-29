import { memo } from 'react'
import type { Components } from 'react-markdown'
import { remarkGithubAlerts } from '../../../lib/remark-github-alerts'
import { MarkdownRenderer, sharedMarkdownComponents } from '../../components/markdown/MarkdownRenderer'
import { renderMarkdownPre } from '../../components/markdown/MarkdownCodeBlock'
import { WikiTreeBlock } from './WikiTreeBlock'
import { WikiPlainCodeBlock } from './WikiPlainCodeBlock'
import { isAsciiTree } from './wikiTreeDetect'

const ALERT_LABELS: Record<string, string> = {
  note: 'Note',
  tip: 'Tip',
  important: 'Important',
  warning: 'Warning',
  caution: 'Caution',
}

const markdownComponents: Components = {
  ...sharedMarkdownComponents,
  blockquote({ className, children, ...props }) {
    const classes = String(className ?? '')
    const alertMatch = /markdown-alert-(\w+)/.exec(classes)
    if (!alertMatch) {
      return (
        <blockquote className={className} {...props}>
          {children}
        </blockquote>
      )
    }

    const alertType = alertMatch[1]
    const label = ALERT_LABELS[alertType] ?? alertType

    return (
      <blockquote className={className} {...props}>
        <p className="markdown-alert-title">{label}</p>
        {children}
      </blockquote>
    )
  },
  pre({ children }) {
    return renderMarkdownPre(children, {
      isTree: isAsciiTree,
      renderTree: code => <WikiTreeBlock code={code} />,
      renderPlain: code => <WikiPlainCodeBlock code={code} />,
    })
  },
  table({ children, ...props }) {
    return (
      <div className="wiki-table-wrap">
        <table {...props}>{children}</table>
      </div>
    )
  },
}

// The Wiki keeps both views mounted; switching tabs must not reparse the document.
export const WikiMarkdown = memo(function WikiMarkdown({ content }: { content: string }) {
  return (
    <MarkdownRenderer
      content={content}
      className="wiki-markdown"
      conversationClass={false}
      components={markdownComponents}
      remarkPlugins={[remarkGithubAlerts]}
    />
  )
})
