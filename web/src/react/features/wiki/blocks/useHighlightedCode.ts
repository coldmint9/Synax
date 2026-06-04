import { useState, useEffect } from 'react'
import { unified } from 'unified'
import rehypePrettyCode from 'rehype-pretty-code'
import { toHtml } from 'hast-util-to-html'
import type { Root, Element, Text } from 'hast'

const cache = new Map<string, string>()

function buildHast(code: string, language: string): Root {
  const codeNode: Element = {
    type: 'element',
    tagName: 'code',
    properties: { className: [`language-${language}`] },
    children: [{ type: 'text', value: code } as Text],
  }
  const preNode: Element = {
    type: 'element',
    tagName: 'pre',
    properties: {},
    children: [codeNode],
  }
  return { type: 'root', children: [preNode] }
}

let processorPromise: Promise<any> | null = null

function getProcessor() {
  if (!processorPromise) {
    processorPromise = (async () => {
      const processor = unified()
        .use(rehypePrettyCode, {
          theme: { dark: 'github-dark', light: 'github-light' },
          keepBackground: false,
        })
      return processor
    })()
  }
  return processorPromise
}

export function useHighlightedCode(code: string, language: string): string | null {
  const [html, setHtml] = useState<string | null>(() => cache.get(`${language}:${code}`) ?? null)

  useEffect(() => {
    const key = `${language}:${code}`
    if (cache.has(key)) {
      setHtml(cache.get(key)!)
      return
    }

    let cancelled = false
    getProcessor().then(async (processor) => {
      const tree = buildHast(code, language)
      const result = await processor.run(tree)
      const output = toHtml(result)
      cache.set(key, output)
      if (!cancelled) setHtml(output)
    })
    return () => { cancelled = true }
  }, [code, language])

  return html
}
