import type { Blockquote, Paragraph, Root } from 'mdast'
import { visit } from 'unist-util-visit'

const ALERT_ONLY = /^\[!(\w+)\]\s*$/i
const ALERT_INLINE = /^\[!(\w+)\]\s*\n([\s\S]*)$/i
const ALERT_SAME_LINE = /^\[!(\w+)\]\s+([\s\S]+)$/i

function paragraphText(node: Paragraph): string {
  return node.children
    .filter((child): child is { type: 'text'; value: string } => child.type === 'text')
    .map(child => child.value)
    .join('')
}

function setParagraphText(node: Paragraph, value: string) {
  node.children = value ? [{ type: 'text', value }] : []
}

function markAlert(blockquote: Blockquote, alertType: string) {
  blockquote.data = {
    ...blockquote.data,
    hProperties: {
      className: ['markdown-alert', `markdown-alert-${alertType}`],
    },
  }
}

/** Parse GitHub-style blockquote alerts: > [!IMPORTANT] */
export function remarkGithubAlerts() {
  return (tree: Root) => {
    visit(tree, 'blockquote', blockquote => {
      const first = blockquote.children[0]
      if (!first || first.type !== 'paragraph') return

      const text = paragraphText(first)
      const only = text.match(ALERT_ONLY)
      if (only) {
        markAlert(blockquote, only[1].toLowerCase())
        blockquote.children.shift()
        return
      }

      const inline = text.match(ALERT_INLINE)
      if (inline) {
        markAlert(blockquote, inline[1].toLowerCase())
        setParagraphText(first, inline[2].trimStart())
        if (!paragraphText(first)) blockquote.children.shift()
        return
      }

      const sameLine = text.match(ALERT_SAME_LINE)
      if (sameLine) {
        markAlert(blockquote, sameLine[1].toLowerCase())
        setParagraphText(first, sameLine[2].trim())
      }
    })
  }
}
