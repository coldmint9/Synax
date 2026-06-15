import ReactMarkdown from 'react-markdown'
import type { Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { remarkGithubAlerts } from '../../../lib/remark-github-alerts'
import { MermaidBlock } from './MermaidBlock'
import { ShikiCodeBlock } from './ShikiCodeBlock'
import { WikiTreeBlock } from './WikiTreeBlock'
import { WikiPlainCodeBlock } from './WikiPlainCodeBlock'
import { isAsciiTree } from './wikiTreeDetect'

const TREE_LANGUAGES = new Set(['tree', 'ascii', 'ascii-tree', 'directory-tree'])

function renderCodeBlock(code: string, language?: string) {
  if (language === 'mermaid') {
    return <MermaidBlock code={code} />
  }

  if (language && !TREE_LANGUAGES.has(language) && !(language === 'text' || language === 'plaintext')) {
    return <ShikiCodeBlock code={code} language={language} />
  }

  if (isAsciiTree(code) || (language && TREE_LANGUAGES.has(language))) {
    return <WikiTreeBlock code={code} />
  }

  if (language === 'text' || language === 'plaintext') {
    return <WikiPlainCodeBlock code={code} />
  }

  if (code.includes('\n')) {
    return <WikiPlainCodeBlock code={code} />
  }

  return null
}

const ALERT_LABELS: Record<string, string> = {
  note: 'Note',
  tip: 'Tip',
  important: 'Important',
  warning: 'Warning',
  caution: 'Caution',
}

const markdownComponents: Components = {
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
    return <>{children}</>
  },
  code({ className, children, ...props }) {
    const match = /language-(\w+)/.exec(className ?? '')
    const language = match?.[1]
    const code = String(children).replace(/\n$/, '')

    const block = renderCodeBlock(code, language)
    if (block) return block

    return (
      <code className={className} {...props}>
        {children}
      </code>
    )
  },
}

export function WikiMarkdown({ content }: { content: string }) {
  return (
    <ReactMarkdown remarkPlugins={[remarkGfm, remarkGithubAlerts]} components={markdownComponents}>
      {content}
    </ReactMarkdown>
  )
}
