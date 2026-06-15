/** Box-drawing and tree guide characters used in directory trees. */
const TREE_CHAR_RE = /[├└│┬┴┤─┏┓┗┛┃┣┫╭╮╯╰]/

export function isAsciiTree(text: string): boolean {
  const trimmed = text.trim()
  if (!trimmed) return false

  const lines = trimmed.split(/\r?\n/)
  if (lines.length < 2) return false

  const structuralLines = lines.filter(line => TREE_CHAR_RE.test(line))
  if (structuralLines.length >= 2) return true
  if (structuralLines.length >= 1 && lines.length >= 3) return true

  const tabPathLines = lines.filter(line => /^\t+\S/.test(line)).length
  if (tabPathLines >= 2) return true

  return false
}

export function splitTreeLineComment(line: string): { structure: string; comment: string | null } {
  const match = line.match(/^(.+?\S)(\s+#\s+)(.+)$/)
  if (!match) return { structure: line, comment: null }
  return { structure: match[1], comment: `# ${match[3]}` }
}
