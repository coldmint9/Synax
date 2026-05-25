import { renderMermaidSVG } from 'beautiful-mermaid'

const SUPPORTED_RE = /^(graph|flowchart|sequenceDiagram|classDiagram|erDiagram|stateDiagram|xychart)/

type RenderResult = { svg: string } | { error: string } | null

export function renderDiagram(code: string): RenderResult {
  const trimmed = code.trim()
  if (!SUPPORTED_RE.test(trimmed)) return null
  try {
    const svg = renderMermaidSVG(trimmed, {
      bg: 'var(--background)',
      fg: 'var(--foreground)',
      transparent: true,
    })
    return { svg }
  } catch (e) {
    return { error: e instanceof Error ? e.message : String(e) }
  }
}
