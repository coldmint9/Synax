import type { ChunkEntry, FileEntry, SymbolEntry } from '../contracts/forest.js'
import type { CodeMapCallEdge, CodeMapImport } from '../contracts/code-map.js'
import {
	chunkForFile,
	chunkForSymbol,
	compact,
	detectLanguage,
	detectParserLanguage,
	hashParts,
	makeFileId,
	makeSymbolId,
	readTextFile,
	type AnalyzerSourceFile,
	type ParserLanguageKey,
} from './shared.js'

type TreeSitterNode = {
	type: string
	startPosition: { row: number }
	endPosition: { row: number }
	startIndex: number
	endIndex: number
	namedChildren?: TreeSitterNode[]
	childCount?: number
	namedChildCount?: number
	child?(index: number): TreeSitterNode | null
	namedChild?(index: number): TreeSitterNode | null
	childForFieldName?(name: string): TreeSitterNode | null
}

type TreeSitterTree = { rootNode: TreeSitterNode }
type TreeSitterParser = {
	setLanguage(language: unknown): void
	parse(source: string): TreeSitterTree
}

const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<any>
const parserCtorPromise = loadParserConstructor()
const languagePromiseCache = new Map<ParserLanguageKey, Promise<unknown | null>>()

const IDENTIFIER_TYPES = new Set([
	'identifier',
	'type_identifier',
	'property_identifier',
	'field_identifier',
	'namespace_identifier',
	'variable_name',
	'name',
	'constant',
	'simple_identifier',
])

const DECLARATION_NODE_TO_KIND: Array<[pattern: RegExp, kind: SymbolEntry['kind']]> = [
	[/namespace|module_declaration|module_definition|mod_item/i, 'namespace'],
	[/interface/i, 'interface'],
	[/enum/i, 'enum'],
	[/struct/i, 'struct'],
	[/class/i, 'class'],
	[/trait/i, 'interface'],
	[/protocol/i, 'interface'],
	[/type_alias|type_definition/i, 'type'],
	[/method|constructor/i, 'method'],
	[/function|func|lambda|def/i, 'function'],
	[/const/i, 'const'],
	[/field|property|member_variable/i, 'field'],
]

const SYMBOL_NODE_TYPES = new Set([
	'abstract_class_declaration',
	'class',
	'class_declaration',
	'class_definition',
	'class_specifier',
	'constructor_declaration',
	'enum_declaration',
	'enum_specifier',
	'field_declaration',
	'function_declaration',
	'function_definition',
	'function_item',
	'interface_declaration',
	'method',
	'method_declaration',
	'method_definition',
	'mod_item',
	'module_declaration',
	'namespace_declaration',
	'namespace_definition',
	'object_declaration',
	'property_declaration',
	'protocol_declaration',
	'singleton_method',
	'struct_declaration',
	'struct_item',
	'struct_specifier',
	'trait_declaration',
	'trait_item',
	'type_alias',
	'type_alias_declaration',
	'type_declaration',
	'type_definition',
	'variable_declarator',
])

async function loadParserConstructor(): Promise<(new () => TreeSitterParser) | null> {
	try {
		const mod = await dynamicImport('tree-sitter')
		return (mod.default ?? mod) as new () => TreeSitterParser
	} catch {
		return null
	}
}

async function loadLanguage(language: ParserLanguageKey): Promise<unknown | null> {
	const cached = languagePromiseCache.get(language)
	if (cached) return cached
	const promise = (async () => {
		try {
			switch (language) {
				case 'typescript': {
					const mod = await dynamicImport('tree-sitter-typescript')
					return mod.typescript ?? mod.default?.typescript ?? mod.default ?? null
				}
				case 'tsx': {
					const mod = await dynamicImport('tree-sitter-typescript')
					return mod.tsx ?? mod.default?.tsx ?? mod.typescript ?? mod.default ?? null
				}
				case 'javascript':
				case 'jsx': {
					const mod = await dynamicImport('tree-sitter-javascript')
					return mod.javascript ?? mod.default?.javascript ?? mod.default ?? null
				}
				case 'python':
					return (await dynamicImport('tree-sitter-python')).default ?? null
				case 'java':
					return (await dynamicImport('tree-sitter-java')).default ?? null
				case 'c':
					return (await dynamicImport('tree-sitter-c')).default ?? null
				case 'cpp':
					return (await dynamicImport('tree-sitter-cpp')).default ?? null
				case 'csharp':
					return (await dynamicImport('tree-sitter-c-sharp')).default ?? null
				case 'go':
					return (await dynamicImport('tree-sitter-go')).default ?? null
				case 'rust':
					return (await dynamicImport('tree-sitter-rust')).default ?? null
				case 'php': {
					const mod = await dynamicImport('tree-sitter-php')
					return mod.php ?? mod.default?.php ?? mod.default ?? null
				}
				case 'ruby':
					return (await dynamicImport('tree-sitter-ruby')).default ?? null
				case 'kotlin':
					return (await dynamicImport('tree-sitter-kotlin')).default ?? null
				case 'swift':
					return (await dynamicImport('tree-sitter-swift')).default ?? null
				default:
					return null
			}
		} catch {
			return null
		}
	})()
	languagePromiseCache.set(language, promise)
	return promise
}

async function parseTreeSitterSymbols(
	language: ParserLanguageKey,
	fileId: string,
	relPath: string,
	text: string,
	warnings: string[],
): Promise<SymbolEntry[]> {
	const ParserCtor = await parserCtorPromise
	if (ParserCtor == null) {
		warnings.push('tree-sitter parser unavailable; used fallback')
		return []
	}
	const languageDef = await loadLanguage(language)
	if (!languageDef) {
		warnings.push(`tree-sitter language unavailable for ${language}; used fallback`)
		return []
	}

	try {
		const parser = new ParserCtor()
		parser.setLanguage(languageDef)
		const tree = parser.parse(text)
		return extractSymbolsFromTree(tree.rootNode, fileId, relPath, text)
	} catch (err) {
		warnings.push(`tree-sitter parse failed: ${err instanceof Error ? compact(err.message, 120) : 'unknown error'}`)
		return []
	}
}

function extractSymbolsFromTree(rootNode: TreeSitterNode, fileId: string, relPath: string, text: string): SymbolEntry[] {
	const symbols: SymbolEntry[] = []
	walkNamed(rootNode, (node, parent) => {
		const kind = classifySymbolKind(node.type, parent?.type)
		if (!kind) return
		const name = extractSymbolName(node, text)
		if (!name) return
		const line = node.startPosition.row + 1
		const qualifiedName = `${relPath}:${name}`
		symbols.push({
			id: makeSymbolId(fileId, qualifiedName, line),
			fileId,
			kind,
			name,
			qualifiedName,
			range: {
				startLine: line,
				endLine: Math.max(line, node.endPosition.row + 1),
			},
			signature: compact(text.slice(node.startIndex, node.endIndex), 220),
		})
	})
	return symbols
}

function walkNamed(node: TreeSitterNode, visitor: (node: TreeSitterNode, parent: TreeSitterNode | null) => void, parent: TreeSitterNode | null = null): void {
	visitor(node, parent)
	const namedChildren = getNamedChildren(node)
	for (const child of namedChildren) {
		walkNamed(child, visitor, node)
	}
}

function getNamedChildren(node: TreeSitterNode): TreeSitterNode[] {
	if (Array.isArray(node.namedChildren)) return node.namedChildren
	const out: TreeSitterNode[] = []
	const count = node.namedChildCount ?? 0
	if (typeof node.namedChild === 'function') {
		for (let index = 0; index < count; index += 1) {
			const child = node.namedChild(index)
			if (child) out.push(child)
		}
	}
	return out
}

function classifySymbolKind(nodeType: string, parentType?: string): SymbolEntry['kind'] | null {
	if (!SYMBOL_NODE_TYPES.has(nodeType) && !/declaration|definition|specifier|item|method|function|class|struct|interface|enum|namespace|module/i.test(nodeType)) {
		return null
	}
	if (nodeType === 'variable_declarator') {
		if (!parentType || !/lexical|variable|property|field|const/i.test(parentType)) return null
	}
	for (const [pattern, kind] of DECLARATION_NODE_TO_KIND) {
		if (pattern.test(nodeType)) return kind
	}
	return null
}

function extractSymbolName(node: TreeSitterNode, text: string): string | null {
	const direct = safeFieldChild(node, 'name')
	if (direct) return text.slice(direct.startIndex, direct.endIndex).trim()
	const firstIdentifier = findIdentifier(node, 2)
	if (firstIdentifier) return text.slice(firstIdentifier.startIndex, firstIdentifier.endIndex).trim()
	return null
}

function safeFieldChild(node: TreeSitterNode, field: string): TreeSitterNode | null {
	try {
		return node.childForFieldName?.(field) ?? null
	} catch {
		return null
	}
}

function findIdentifier(node: TreeSitterNode, maxDepth: number, depth = 0): TreeSitterNode | null {
	if (IDENTIFIER_TYPES.has(node.type)) return node
	if (depth >= maxDepth) return null
	for (const child of getNamedChildren(node)) {
		const found = findIdentifier(child, maxDepth, depth + 1)
		if (found) return found
	}
	return null
}

function dedupeSymbols(symbols: SymbolEntry[]): SymbolEntry[] {
	const seen = new Set<string>()
	const out: SymbolEntry[] = []
	for (const symbol of symbols) {
		const key = `${symbol.fileId}:${symbol.kind}:${symbol.name}:${symbol.range.startLine}`
		if (seen.has(key)) continue
		seen.add(key)
		out.push(symbol)
	}
	return out.sort((a, b) => a.range.startLine - b.range.startLine || a.name.localeCompare(b.name))
}

function parseImports(language: string, fileId: string, text: string): CodeMapImport[] {
	const imports: CodeMapImport[] = []
	const lines = text.split(/\r?\n/)
	let inGoBlock = false
	for (const [index, line] of lines.entries()) {
		const lineNo = index + 1
		const trimmed = line.trim()
		if (language === 'python') {
			const fromMatch = trimmed.match(/^from\s+([A-Za-z0-9_./]+|\.+[A-Za-z0-9_./]*)\s+import\s+/)
			if (fromMatch) {
				const raw = fromMatch[1]
				const level = raw.match(/^\.+/)?.[0].length ?? 0
				imports.push({
					sourceFileId: fileId,
					targetModule: raw.replace(/^\.+/, ''),
					line: lineNo,
					level,
					isExternal: false,
				})
			}
			const importMatch = trimmed.match(/^import\s+([A-Za-z0-9_./]+)/)
			if (importMatch) {
				imports.push({
					sourceFileId: fileId,
					targetModule: importMatch[1],
					line: lineNo,
					level: 0,
					isExternal: false,
				})
			}
			continue
		}

		if (language === 'go') {
			if (/^import\s*\(/.test(trimmed)) {
				inGoBlock = true
				continue
			}
			if (inGoBlock) {
				if (trimmed === ')') {
					inGoBlock = false
					continue
				}
				const blockImport = trimmed.match(/^"([^"]+)"/)
				if (blockImport) {
					imports.push({ sourceFileId: fileId, targetModule: blockImport[1], line: lineNo, level: 0, isExternal: false })
				}
				continue
			}
		}

		const jsImport = trimmed.match(/^import\s+.*?\s+from\s+['"]([^'"]+)['"]/)
			?? trimmed.match(/^import\s+['"]([^'"]+)['"]/)
			?? trimmed.match(/^export\s+\*\s+from\s+['"]([^'"]+)['"]/)
		if (jsImport) {
			const target = jsImport[1]
			imports.push({
				sourceFileId: fileId,
				targetModule: target,
				line: lineNo,
				level: target.startsWith('.') ? target.split('/').filter((segment) => segment === '..').length : 0,
				isExternal: !target.startsWith('.') && !target.startsWith('/'),
			})
			continue
		}

		const requireImport = trimmed.match(/require\(\s*['"]([^'"]+)['"]\s*\)/)
		if (requireImport) {
			const target = requireImport[1]
			imports.push({
				sourceFileId: fileId,
				targetModule: target,
				line: lineNo,
				level: target.startsWith('.') ? target.split('/').filter((segment) => segment === '..').length : 0,
				isExternal: !target.startsWith('.') && !target.startsWith('/'),
			})
			continue
		}

		const cInclude = trimmed.match(/^#\s*include\s+([<"][^>"]+[>"])/)
		if (cInclude) {
			const target = cInclude[1].slice(1, -1)
			imports.push({
				sourceFileId: fileId,
				targetModule: target,
				line: lineNo,
				level: 0,
				isExternal: cInclude[1].startsWith('<'),
			})
			continue
		}

		const langImport = trimmed.match(/^(?:import|using|use)\s+([A-Za-z0-9_.$:\\/\\-]+)/)
		if (langImport) {
			imports.push({
				sourceFileId: fileId,
				targetModule: langImport[1],
				line: lineNo,
				level: 0,
				isExternal: false,
			})
			continue
		}

		const rubyRequire = trimmed.match(/^require(?:_relative)?\s+['"]([^'"]+)['"]/)
		if (rubyRequire) {
			imports.push({
				sourceFileId: fileId,
				targetModule: rubyRequire[1],
				line: lineNo,
				level: trimmed.startsWith('require_relative') ? 1 : 0,
				isExternal: !trimmed.startsWith('require_relative'),
			})
			continue
		}
	}

	return imports
}

function parseSymbolsFallback(language: string, fileId: string, relPath: string, text: string): SymbolEntry[] {
	const lines = text.split(/\r?\n/)
	const symbols: Array<SymbolEntry & { line: number }> = []
	const push = (kind: SymbolEntry['kind'], name: string, line: number, signature?: string) => {
		const qualifiedName = `${relPath}:${name}`
		symbols.push({
			id: makeSymbolId(fileId, qualifiedName, line),
			fileId,
			kind,
			name,
			qualifiedName,
			range: { startLine: line, endLine: line },
			signature,
			line,
		})
	}

	for (const [index, line] of lines.entries()) {
		const lineNo = index + 1
		const trimmed = line.trim()
		if (language === 'python') {
			const classMatch = trimmed.match(/^(?:async\s+)?class\s+([A-Za-z_][A-Za-z0-9_]*)/)
			if (classMatch) push('class', classMatch[1], lineNo, trimmed)
			const defMatch = trimmed.match(/^(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/)
			if (defMatch) push('function', defMatch[1], lineNo, trimmed)
			continue
		}
		const patterns: Array<[RegExp, SymbolEntry['kind']]> = [
			[/^export\s+(?:default\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/, 'function'],
			[/^function\s+([A-Za-z_$][\w$]*)\s*\(/, 'function'],
			[/^(?:export\s+)?(?:default\s+)?class\s+([A-Za-z_$][\w$]*)/, 'class'],
			[/^(?:export\s+)?interface\s+([A-Za-z_$][\w$]*)/, 'interface'],
			[/^(?:export\s+)?type\s+([A-Za-z_$][\w$]*)/, 'type'],
			[/^(?:export\s+)?enum\s+([A-Za-z_$][\w$]*)/, 'enum'],
			[/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\s*\(|\([^)]*\)\s*=>)/, 'const'],
			[/^(?:public|private|protected)?\s*(?:static\s+)?(?:class|interface|enum|struct)\s+([A-Za-z_][A-Za-z0-9_]*)/, 'class'],
			[/^(?:public|private|protected)?\s*(?:async\s+)?(?:static\s+)?[A-Za-z_<>\[\],?]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/, 'function'],
			[/^func\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/, 'function'],
			[/^type\s+([A-Za-z_][A-Za-z0-9_]*)\s+(?:struct|interface)/, 'struct'],
			[/^struct\s+([A-Za-z_][A-Za-z0-9_]*)/, 'struct'],
			[/^trait\s+([A-Za-z_][A-Za-z0-9_]*)/, 'interface'],
			[/^protocol\s+([A-Za-z_][A-Za-z0-9_]*)/, 'interface'],
		]
		for (const [pattern, kind] of patterns) {
			const match = trimmed.match(pattern)
			if (match) {
				push(kind, match[1], lineNo, trimmed)
				break
			}
		}
	}

	const ordered = symbols.sort((a, b) => a.line - b.line || a.name.localeCompare(b.name))
	for (let index = 0; index < ordered.length; index += 1) {
		const current = ordered[index]
		current.range.endLine = index + 1 < ordered.length ? Math.max(current.range.startLine, ordered[index + 1].line - 1) : lines.length
	}
	return ordered.map(({ line: _line, ...symbol }) => symbol)
}

// ── Call Expression Extraction ───────────────────────────────────────────────

const CALL_NODE_TYPES = new Set([
	'call_expression',
	'method_invocation',
	'function_call',
	'call',
	'invocation_expression',
])

async function parseTreeSitterCalls(
	language: ParserLanguageKey,
	fileId: string,
	text: string,
	fileSymbols: SymbolEntry[],
	warnings: string[],
): Promise<CodeMapCallEdge[]> {
	const ParserCtor = await parserCtorPromise
	if (ParserCtor == null) return parseCallsFallback('', fileId, text, fileSymbols)
	const languageDef = await loadLanguage(language)
	if (!languageDef) return parseCallsFallback('', fileId, text, fileSymbols)

	try {
		const parser = new ParserCtor()
		parser.setLanguage(languageDef)
		const tree = parser.parse(text)
		return extractCallsFromTree(tree.rootNode, fileId, text, fileSymbols)
	} catch {
		return parseCallsFallback('', fileId, text, fileSymbols)
	}
}

function extractCallsFromTree(
	rootNode: TreeSitterNode,
	fileId: string,
	text: string,
	fileSymbols: SymbolEntry[],
): CodeMapCallEdge[] {
	const edges: CodeMapCallEdge[] = []
	const seen = new Set<string>()

	walkNamed(rootNode, (node) => {
		if (!CALL_NODE_TYPES.has(node.type)) return
		const calleeName = extractCalleeName(node, text)
		if (!calleeName) return
		const line = node.startPosition.row + 1
		const enclosing = findEnclosingSymbol(fileSymbols, line)
		if (!enclosing) return
		const key = `${enclosing.id}:${calleeName}:${line}`
		if (seen.has(key)) return
		seen.add(key)
		edges.push({
			sourceSymbolId: enclosing.id,
			targetName: calleeName,
			line,
			fileId,
		})
	})

	return edges.slice(0, 500)
}

function extractCalleeName(node: TreeSitterNode, text: string): string | null {
	const funcChild = safeFieldChild(node, 'function')
		?? safeFieldChild(node, 'method')
		?? safeFieldChild(node, 'name')
	if (funcChild) {
		if (IDENTIFIER_TYPES.has(funcChild.type)) {
			return text.slice(funcChild.startIndex, funcChild.endIndex).trim()
		}
		const prop = safeFieldChild(funcChild, 'property')
			?? safeFieldChild(funcChild, 'field')
			?? safeFieldChild(funcChild, 'name')
		if (prop && IDENTIFIER_TYPES.has(prop.type)) {
			return text.slice(prop.startIndex, prop.endIndex).trim()
		}
		const lastIdent = findLastIdentifier(funcChild)
		if (lastIdent) return text.slice(lastIdent.startIndex, lastIdent.endIndex).trim()
	}
	const firstChild = getNamedChildren(node)[0]
	if (firstChild) {
		if (IDENTIFIER_TYPES.has(firstChild.type)) {
			return text.slice(firstChild.startIndex, firstChild.endIndex).trim()
		}
		const lastIdent = findLastIdentifier(firstChild)
		if (lastIdent) return text.slice(lastIdent.startIndex, lastIdent.endIndex).trim()
	}
	return null
}

function findLastIdentifier(node: TreeSitterNode): TreeSitterNode | null {
	const children = getNamedChildren(node)
	for (let i = children.length - 1; i >= 0; i--) {
		if (IDENTIFIER_TYPES.has(children[i].type)) return children[i]
	}
	return null
}

function findEnclosingSymbol(symbols: SymbolEntry[], line: number): SymbolEntry | null {
	for (let i = symbols.length - 1; i >= 0; i--) {
		const s = symbols[i]
		if (line >= s.range.startLine && line <= s.range.endLine) return s
	}
	return null
}

function parseCallsFallback(
	_language: string,
	fileId: string,
	text: string,
	fileSymbols: SymbolEntry[],
): CodeMapCallEdge[] {
	const edges: CodeMapCallEdge[] = []
	const seen = new Set<string>()
	const lines = text.split(/\r?\n/)
	const callPattern = /\b([A-Za-z_$][\w$]*)\s*\(/g

	for (const [index, line] of lines.entries()) {
		const lineNo = index + 1
		const enclosing = findEnclosingSymbol(fileSymbols, lineNo)
		if (!enclosing) continue
		let match: RegExpExecArray | null
		callPattern.lastIndex = 0
		while ((match = callPattern.exec(line)) !== null) {
			const name = match[1]
			if (IGNORED_CALL_NAMES.has(name)) continue
			const key = `${enclosing.id}:${name}:${lineNo}`
			if (seen.has(key)) continue
			seen.add(key)
			edges.push({ sourceSymbolId: enclosing.id, targetName: name, line: lineNo, fileId })
		}
	}

	return edges.slice(0, 500)
}

const IGNORED_CALL_NAMES = new Set([
	'if', 'for', 'while', 'switch', 'catch', 'return', 'throw',
	'new', 'typeof', 'instanceof', 'delete', 'void', 'await',
	'require', 'import', 'export', 'console', 'log', 'warn', 'error',
	'parseInt', 'parseFloat', 'String', 'Number', 'Boolean', 'Array', 'Object',
	'print', 'println', 'printf', 'sprintf', 'fmt',
])

export async function parseOneFile(
	absPath: string,
	workDirAbs: string,
): Promise<{
	fileEntry: FileEntry;
	symbols: SymbolEntry[];
	calls: CodeMapCallEdge[];
	imports: CodeMapImport[];
	chunks: ChunkEntry[];
	sourceFile: AnalyzerSourceFile;
	warnings: string[];
} | null> {
	const text = readTextFile(absPath)
	if (text == null) return null
	const relPath = absPath.slice(workDirAbs.length).replace(/^[/\\]/, '').replace(/\\/g, '/')
	const fileId = makeFileId(relPath)
	const language = detectLanguage(absPath)
	const parserLanguage = detectParserLanguage(absPath)
	const entry: FileEntry = {
		id: fileId, path: relPath, language,
		size: Buffer.byteLength(text, 'utf8'),
		sha: hashParts(relPath, text),
	}
	const fileRecord: AnalyzerSourceFile = {
		entry, relPath, absPath, text, language, parserLanguage,
	}
	const parseWarnings: string[] = []
	const treeSymbols = parserLanguage
		? await parseTreeSitterSymbols(parserLanguage, fileId, relPath, text, parseWarnings)
		: []
	const fallbackSymbols = treeSymbols.length > 0 ? [] : parseSymbolsFallback(language, fileId, relPath, text)
	const fileSymbols = dedupeSymbols(treeSymbols.length > 0 ? treeSymbols : fallbackSymbols)
	const fileImports = parseImports(language, fileId, text)
	const fileCalls = parserLanguage
		? await parseTreeSitterCalls(parserLanguage, fileId, text, fileSymbols, parseWarnings)
		: parseCallsFallback(language, fileId, text, fileSymbols)
	const chunks: ChunkEntry[] = []
	if (fileSymbols.length > 0) {
		for (const symbol of fileSymbols.slice(0, 48)) {
			chunks.push(chunkForSymbol(fileId, symbol))
		}
	} else {
		chunks.push(chunkForFile(fileId, text))
	}
	return {
		fileEntry: entry,
		symbols: fileSymbols,
		calls: fileCalls,
		imports: fileImports,
		chunks,
		sourceFile: fileRecord,
		warnings: parseWarnings.map((w) => `${relPath}: ${w}`),
	}
}
