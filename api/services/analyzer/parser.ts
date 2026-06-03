import os from 'node:os'

import type { ChunkEntry, FileEntry, SymbolEntry } from '../contracts/forest.js'
import type { CodeMapCallEdge, CodeMapCodeIndex, CodeMapImport } from '../contracts/code-map.js'
import {
	hashParts,
	now,
	walkRepositoryFiles,
	type AnalyzerParseResult,
	type AnalyzerSourceFile,
} from './shared.js'
import { parseOneFile } from './parse-lib.js'
import { AnalyzerWorkerPool, type FileParseResult } from './worker-pool.js'

// Re-export for backward compatibility — parseOneFile is also available
// for direct (non-worker) use in tests and fallback paths.
export { parseOneFile } from './parse-lib.js'

/**
 * Parse a repository directory into a code index.
 *
 * File discovery runs on the main thread. Per-file parsing (including
 * tree-sitter analysis) is offloaded to a worker thread pool so that
 * the event loop stays responsive during large scans.
 */
export async function parseRepository(workDirAbs: string): Promise<AnalyzerParseResult> {
	const entries: AnalyzerSourceFile[] = []
	const files: FileEntry[] = []
	const symbols: SymbolEntry[] = []
	const chunks: ChunkEntry[] = []
	const imports: CodeMapImport[] = []
	const callEdges: CodeMapCallEdge[] = []
	const allWarnings: string[] = []

	// File discovery (main thread — one-shot, ~2-5s)
	const filePaths = walkRepositoryFiles(workDirAbs)

	if (filePaths.length === 0) {
		return emptyParseResult(workDirAbs, files, symbols, chunks, imports, callEdges, allWarnings)
	}

	// Offload per-file parsing to a worker pool.
	// Pool size defaults to os.cpus().length - 1, configurable via env.
	const poolSize = parsePoolSize()
	const pool = new AnalyzerWorkerPool(poolSize)

	const results = await Promise.all(
		filePaths.map((absPath) =>
			pool.parseFile(absPath, workDirAbs).catch((_err): FileParseResult | null => null),
		),
	)

	await pool.terminate()

	// Merge results on the main thread (pure in-memory operations)
	for (const result of results) {
		if (!result) continue

		entries.push(result.sourceFile)
		files.push(result.fileEntry)
		symbols.push(...result.symbols)
		chunks.push(...result.chunks)
		imports.push(...result.imports)
		callEdges.push(...result.calls)
		allWarnings.push(...result.warnings)
	}

	return {
		codeIndex: {
			indexId: `index_${hashParts(workDirAbs, String(files.length), String(symbols.length), String(imports.length))}`,
			files,
			symbols,
			chunks,
			imports,
			callEdges,
			stats: {
				fileCount: files.length,
				symbolCount: symbols.length,
				chunkCount: chunks.length,
				importCount: imports.length,
				callEdgeCount: callEdges.length,
			},
			updatedAt: now(),
		},
		files: entries,
		warnings: allWarnings,
	}
}

/**
 * Fallback: parse a single file synchronously on the main thread.
 * Used when the worker pool is unavailable (e.g. in test environments).
 */
export async function parseRepositoryFallback(workDirAbs: string): Promise<AnalyzerParseResult> {
	const entries: AnalyzerSourceFile[] = []
	const files: FileEntry[] = []
	const symbols: SymbolEntry[] = []
	const chunks: ChunkEntry[] = []
	const imports: CodeMapImport[] = []
	const callEdges: CodeMapCallEdge[] = []
	const allWarnings: string[] = []

	for (const absPath of walkRepositoryFiles(workDirAbs)) {
		const result = await parseOneFile(absPath, workDirAbs)
		if (!result) continue

		entries.push(result.sourceFile)
		files.push(result.fileEntry)
		symbols.push(...result.symbols)
		chunks.push(...result.chunks)
		imports.push(...result.imports)
		callEdges.push(...result.calls)
		allWarnings.push(...result.warnings)
	}

	return {
		codeIndex: {
			indexId: `index_${hashParts(workDirAbs, String(files.length), String(symbols.length), String(imports.length))}`,
			files,
			symbols,
			chunks,
			imports,
			callEdges,
			stats: {
				fileCount: files.length,
				symbolCount: symbols.length,
				chunkCount: chunks.length,
				importCount: imports.length,
				callEdgeCount: callEdges.length,
			},
			updatedAt: now(),
		},
		files: entries,
		warnings: allWarnings,
	}
}

function parsePoolSize(): number {
	const env = typeof process !== 'undefined' ? process.env.SYNAX_PARSE_POOL_SIZE : undefined
	if (env) {
		const n = parseInt(env, 10)
		if (n >= 1) return n
	}
	return Math.max(1, os.cpus().length - 1)
}

function emptyParseResult(
	workDirAbs: string,
	files: FileEntry[],
	symbols: SymbolEntry[],
	chunks: ChunkEntry[],
	imports: CodeMapImport[],
	callEdges: CodeMapCallEdge[],
	warnings: string[],
): AnalyzerParseResult {
	return {
		codeIndex: {
			indexId: `index_${hashParts(workDirAbs, 'empty')}`,
			files,
			symbols,
			chunks,
			imports,
			callEdges,
			stats: {
				fileCount: 0,
				symbolCount: 0,
				chunkCount: 0,
				importCount: 0,
				callEdgeCount: 0,
			},
			updatedAt: now(),
		},
		files: [],
		warnings,
	}
}
