// ---------------------------------------------------------------------------
// api/services/wiki/wiki-export-service.ts — Wiki → Markdown 导出
// ---------------------------------------------------------------------------

import { eq } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { wikiDocuments, wikiBlocks } from '../../db/schema.js';
import { wikiStore } from './wiki-store.js';
import type { WikiDocument, WikiBlock, MarkdownExportResult } from './contracts.js';
import type { HeadingContent, ProseContent, SignatureContent, CalloutContent, TableContent, DiagramContent, ListContent, ListItem, Segment } from './contracts.js';

function segmentsToMarkdown(segments: Segment[]): string {
  return segments.map(s => {
    if (s.type === 'code') return `\`${s.value}\``;
    if (s.type === 'bold') return `**${s.value}**`;
    if (s.type === 'xref') return `[${s.label}]`;
    return s.value;
  }).join('');
}

function listItemsToMarkdown(items: ListItem[], ordered: boolean, indent = 0): string {
  return items.map((item, i) => {
    const prefix = ordered ? `${'  '.repeat(indent)}${i + 1}. ` : `${'  '.repeat(indent)}- `;
    const text = segmentsToMarkdown(item.segments);
    const children = item.children ? '\n' + listItemsToMarkdown(item.children, ordered, indent + 1) : '';
    return `${prefix}${text}${children}`;
  }).join('\n');
}

function blockToMarkdown(block: WikiBlock): string {
  const content = block.content as Record<string, unknown>;

  switch (block.blockType) {
    case 'heading': {
      const c = content as unknown as HeadingContent;
      return `${'#'.repeat(c.level ?? 2)} ${c.text ?? ''}\n`;
    }
    case 'prose': {
      const c = content as unknown as ProseContent;
      if (c.segments) return `${segmentsToMarkdown(c.segments)}\n`;
      // Legacy fallback
      const text = (content as any).text;
      if (typeof text === 'string') return `${text}\n`;
      return '';
    }
    case 'signature': {
      const c = content as unknown as SignatureContent;
      const code = c.tokens ? c.tokens.map(t => t.value).join('') : '';
      const source = c.source ? `\n<!-- source: ${c.source.file}${c.source.line ? `:${c.source.line}` : ''} -->` : '';
      return `\`\`\`${c.language ?? ''}\n${code}\n\`\`\`${source}\n`;
    }
    case 'callout': {
      const c = content as unknown as CalloutContent;
      const prefix = c.level === 'warn' ? '⚠️' : c.level === 'important' ? '✦' : 'ℹ️';
      const title = c.title ? `**${c.title}** ` : '';
      const body = c.body ? segmentsToMarkdown(c.body) : '';
      return `> ${prefix} ${title}${body}\n`;
    }
    case 'table': {
      const c = content as unknown as TableContent;
      if (!c.headers || c.headers.length === 0) return '';
      const header = `| ${c.headers.map(h => h.label).join(' | ')} |`;
      const sep = `| ${c.headers.map(() => '---').join(' | ')} |`;
      const rows = (c.rows ?? []).map(row =>
        `| ${c.headers.map(h => {
          const val = row[h.key];
          if (!val) return '';
          if (typeof val === 'string') return val;
          return `\`${val.value}\``;
        }).join(' | ')} |`
      ).join('\n');
      return [header, sep, rows].filter(Boolean).join('\n') + '\n';
    }
    case 'diagram': {
      const c = content as unknown as DiagramContent;
      const caption = c.caption ? `\n*${c.caption}*` : '';
      // Also handle legacy markdown_fragment diagrams
      const code = c.code ?? (typeof block.content === 'string' ? block.content : '');
      return `\`\`\`mermaid\n${code}\n\`\`\`${caption}\n`;
    }
    case 'list': {
      const c = content as unknown as ListContent;
      if (c.items) return listItemsToMarkdown(c.items, c.ordered ?? false) + '\n';
      // Legacy fallback
      const items = (content as any).items as string[] | undefined;
      if (Array.isArray(items)) return items.map(item => `- ${item}`).join('\n') + '\n';
      return '';
    }
    default: {
      // Legacy markdown_fragment fallback
      if (block.contentFormat === 'markdown_fragment' && typeof block.content === 'string') {
        return block.content + '\n';
      }
      return '';
    }
  }
}

function documentToMarkdown(doc: WikiDocument, blocks: WikiBlock[], includeSourceRefs: boolean): string {
  const lines: string[] = [`# ${doc.title}\n`];

  for (const blockId of doc.blockIds) {
    const block = blocks.find(b => b.id === blockId);
    if (!block) continue;
    const md = blockToMarkdown(block);
    if (md) lines.push(md);

    if (includeSourceRefs && block.sourceBindingIds.length > 0) {
      lines.push(`<!-- bindings: ${block.sourceBindingIds.join(', ')} -->\n`);
    }
  }

  return lines.join('\n');
}

export const wikiExportService = {
  async exportSnapshot(
    snapshotId: string,
    opts: { includeSourceRefs?: boolean } = {},
  ): Promise<MarkdownExportResult> {
    const tree = await wikiStore.getSnapshotTree(snapshotId);
    if (!tree) throw new Error(`WikiSnapshot not found: ${snapshotId}`);

    const { snapshot, documents, blocks } = tree;
    const includeSourceRefs = opts.includeSourceRefs ?? false;

    const sections = documents
      .sort((a, b) => a.sortOrder - b.sortOrder)
      .map(doc => documentToMarkdown(doc, blocks, includeSourceRefs));

    const content = sections.join('\n---\n\n');
    const fileName = `wiki-${snapshot.projectId}-r${snapshot.revision}.md`;

    return { fileName, content, snapshotId, revision: snapshot.revision };
  },

  async exportDocument(
    documentId: string,
    opts: { includeSourceRefs?: boolean } = {},
  ): Promise<MarkdownExportResult> {
    const db = getDb();
    const docRows = await db.select().from(wikiDocuments).where(eq(wikiDocuments.id, documentId)).limit(1);
    if (!docRows[0]) throw new Error(`WikiDocument not found: ${documentId}`);

    const snapshot = await wikiStore.getSnapshot(docRows[0].snapshotId);
    if (!snapshot) throw new Error(`WikiSnapshot not found for document: ${documentId}`);

    const blockRows = await db.select().from(wikiBlocks).where(eq(wikiBlocks.documentId, documentId));
    const blocks = blockRows.map(r => ({
      id: r.id,
      projectId: r.projectId,
      documentId: r.documentId,
      blockType: r.blockType as WikiBlock['blockType'],
      content: JSON.parse(r.contentJson),
      contentFormat: r.contentFormat as WikiBlock['contentFormat'],
      sourceBindingIds: JSON.parse(r.sourceBindingIdsJson) as string[],
      contentHash: r.contentHash,
      generatedFromHash: r.generatedFromHash ?? null,
      staleState: r.staleState as WikiBlock['staleState'],
      manualState: r.manualState as WikiBlock['manualState'],
      confidence: r.confidence,
      generatedBy: JSON.parse(r.generatedByJson) as WikiBlock['generatedBy'],
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
    }));

    const doc: WikiDocument = {
      id: docRows[0].id,
      snapshotId: docRows[0].snapshotId,
      projectId: docRows[0].projectId,
      title: docRows[0].title,
      docType: docRows[0].docType as WikiDocument['docType'],
      parentId: docRows[0].parentId ?? null,
      pipelineStage: docRows[0].pipelineStage as WikiDocument['pipelineStage'],
      blockIds: JSON.parse(docRows[0].blockIdsJson) as string[],
      sortOrder: docRows[0].sortOrder,
      createdAt: docRows[0].createdAt,
      updatedAt: docRows[0].updatedAt,
    };

    const content = documentToMarkdown(doc, blocks, opts.includeSourceRefs ?? false);
    const fileName = `wiki-doc-${documentId}.md`;

    return { fileName, content, snapshotId: snapshot.id, revision: snapshot.revision };
  },
};
