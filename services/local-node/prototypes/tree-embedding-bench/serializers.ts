import type { ChunkContext, SerializationStrategy, SymbolContext } from './contracts.js';

const CHUNK_STRATEGIES: SerializationStrategy[] = ['chunk-source', 'chunk-enriched'];
const SYMBOL_STRATEGIES: SerializationStrategy[] = ['signature', 'symbol-card', 'skeleton', 'graph-context'];

export function listSerializationStrategies(mode: 'chunk' | 'symbol' | 'all' = 'all'): SerializationStrategy[] {
  if (mode === 'chunk') return [...CHUNK_STRATEGIES];
  if (mode === 'symbol') return [...SYMBOL_STRATEGIES];
  return [...CHUNK_STRATEGIES, ...SYMBOL_STRATEGIES];
}

export function defaultChunkStrategy(): SerializationStrategy {
  return 'chunk-enriched';
}

export function isChunkStrategy(strategy: SerializationStrategy): boolean {
  return strategy === 'chunk-source' || strategy === 'chunk-enriched';
}

export function serializeChunkContext(
  ctx: ChunkContext,
  strategy: SerializationStrategy,
): string {
  switch (strategy) {
    case 'chunk-source':
      return serializeChunkSource(ctx);
    case 'chunk-enriched':
      return serializeChunkEnriched(ctx);
    default:
      return serializeChunkEnriched(ctx);
  }
}

const MAX_EMBED_TEXT_CHARS = 1_200;

export function truncateForEmbedding(text: string, maxChars = MAX_EMBED_TEXT_CHARS): string {
  if (text.length <= maxChars) return text;
  return `${text.slice(0, maxChars - 1)}…`;
}

export function serializeForEmbedding(
  ctx: ChunkContext,
  strategy: SerializationStrategy,
): string {
  const raw = isChunkStrategy(strategy)
    ? serializeChunkContext(ctx, strategy)
    : serializeSymbolContextFromChunk(ctx, strategy);
  return truncateForEmbedding(raw);
}

function serializeSymbolContextFromChunk(
  ctx: ChunkContext,
  strategy: SerializationStrategy,
): string {
  const primary = ctx.symbols[0];
  if (!primary) return serializeChunkSource(ctx);
  const symbolCtx: SymbolContext = {
    symbol: primary,
    file: ctx.file,
    callees: ctx.callees,
    callers: ctx.callers,
    imports: ctx.imports,
  };
  return serializeSymbolContext(symbolCtx, strategy);
}

export function serializeSymbolContext(
  ctx: SymbolContext,
  strategy: SerializationStrategy,
): string {
  switch (strategy) {
    case 'signature':
      return serializeSignature(ctx);
    case 'symbol-card':
      return serializeSymbolCard(ctx);
    case 'skeleton':
      return serializeSkeleton(ctx);
    case 'graph-context':
      return serializeGraphContext(ctx);
    default:
      return serializeSymbolCard(ctx);
  }
}

/** path + 行号 + 源码切片（analyzer chunk 边界） */
function serializeChunkSource(ctx: ChunkContext): string {
  const header = [
    `path: ${ctx.file.path}`,
    `lines: ${ctx.chunk.range.startLine}-${ctx.chunk.range.endLine}`,
    `language: ${ctx.file.language}`,
  ];
  if (ctx.symbols.length > 0) {
    header.push(
      `symbols: ${ctx.symbols.map((s) => `${s.kind} ${s.name}`).join(', ')}`,
    );
  }
  return `${header.join('\n')}\n---\n${ctx.sourceText}`;
}

/** chunk 源码 + 符号签名 + 调用图 */
function serializeChunkEnriched(ctx: ChunkContext): string {
  const lines = [
    `path: ${ctx.file.path}`,
    `lines: ${ctx.chunk.range.startLine}-${ctx.chunk.range.endLine}`,
    `language: ${ctx.file.language}`,
  ];
  if (ctx.symbols.length > 0) {
    for (const sym of ctx.symbols.slice(0, 4)) {
      lines.push(`symbol: ${sym.kind} ${sym.name}`);
      if (sym.signature) lines.push(`signature: ${sym.signature.slice(0, 220)}`);
    }
  }
  if (ctx.imports.length > 0) {
    lines.push(`imports: ${ctx.imports.slice(0, 6).join(', ')}`);
  }
  if (ctx.callees.length > 0) {
    lines.push(`calls: ${ctx.callees.slice(0, 6).join(', ')}`);
  }
  if (ctx.callers.length > 0) {
    lines.push(`called_by: ${ctx.callers.slice(0, 6).join(', ')}`);
  }
  lines.push('---');
  lines.push(ctx.sourceText);
  return lines.join('\n');
}

function serializeSignature(ctx: SymbolContext): string {
  const sig = ctx.symbol.signature?.trim();
  if (sig) return sig;
  return `${ctx.symbol.kind} ${ctx.symbol.name}`;
}

function serializeSymbolCard(ctx: SymbolContext): string {
  const lines = [
    `kind: ${ctx.symbol.kind}`,
    `path: ${ctx.file.path}`,
    `name: ${ctx.symbol.name}`,
    `qualified: ${ctx.symbol.qualifiedName}`,
  ];
  if (ctx.symbol.signature) {
    lines.push(`signature: ${ctx.symbol.signature}`);
  }
  lines.push(`lines: ${ctx.symbol.range.startLine}-${ctx.symbol.range.endLine}`);
  return lines.join('\n');
}

function serializeSkeleton(ctx: SymbolContext): string {
  const sig = ctx.symbol.signature ?? '';
  const nodeHint = inferAstNodeType(ctx.symbol.kind);
  const namePart = ctx.symbol.name;
  const pathPart = ctx.file.path.replace(/\.[^.]+$/, '').replace(/\//g, '.');
  const sigSkeleton = sig
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
  return [
    `ast: ${nodeHint}`,
    `module: ${pathPart}`,
    `symbol: ${namePart}`,
    sigSkeleton ? `skeleton: ${sigSkeleton}` : null,
  ]
    .filter(Boolean)
    .join('\n');
}

function serializeGraphContext(ctx: SymbolContext): string {
  const base = serializeSymbolCard(ctx);
  const graphLines: string[] = [];
  if (ctx.imports.length > 0) {
    graphLines.push(`imports: ${ctx.imports.slice(0, 8).join(', ')}`);
  }
  if (ctx.callees.length > 0) {
    graphLines.push(`calls: ${ctx.callees.slice(0, 8).join(', ')}`);
  }
  if (ctx.callers.length > 0) {
    graphLines.push(`called_by: ${ctx.callers.slice(0, 8).join(', ')}`);
  }
  return graphLines.length > 0 ? `${base}\n${graphLines.join('\n')}` : base;
}

function inferAstNodeType(kind: string): string {
  switch (kind) {
    case 'function':
      return 'function_declaration';
    case 'method':
      return 'method_definition';
    case 'class':
      return 'class_declaration';
    case 'interface':
      return 'interface_declaration';
    case 'type':
      return 'type_alias_declaration';
    case 'const':
    case 'variable':
      return 'variable_declaration';
    case 'enum':
      return 'enum_declaration';
    default:
      return `${kind}_declaration`;
  }
}
