// ---------------------------------------------------------------------------
// api/services/wiki/wiki-export-service.ts — Wiki → Markdown 导出
// ---------------------------------------------------------------------------

import { eq } from 'drizzle-orm';
import { getDb } from '../../db/index.js';
import { wikiDocuments, wikiBlocks } from '../../db/schema.js';
import { wikiStore } from './wiki-store.js';
import type { WikiDocument, WikiBlock, MarkdownExportResult } from './contracts.js';

function blockToMarkdown(block: WikiBlock): string {
  const content = block.content;

  if (block.blockType === 'heading') {
    const c = content as { level?: number; text?: string };
    const level = c.level ?? 2;
    return `${'#'.repeat(level)} ${c.text ?? ''}\n`;
  }

  if (block.blockType === 'paragraph') {
    const c = content as { text?: string };
    return `${c.text ?? ''}\n`;
  }

  if (block.blockType === 'list') {
    const c = content as { items?: string[]; ordered?: boolean };
    const items = c.items ?? [];
    return items
      .map((item, i) => (c.ordered ? `${i + 1}. ${item}` : `- ${item}`))
      .join('\n') + '\n';
  }

  if (block.blockType === 'table') {
    const c = content as { headers?: string[]; rows?: string[][] };
    const headers = c.headers ?? [];
    const rows = c.rows ?? [];
    if (headers.length === 0) return '';
    const header = `| ${headers.join(' | ')} |`;
    const sep = `| ${headers.map(() => '---').join(' | ')} |`;
    const body = rows.map(row => `| ${row.join(' | ')} |`).join('\n');
    return [header, sep, body].filter(Boolean).join('\n') + '\n';
  }

  if (block.blockType === 'code_ref') {
    const c = content as { language?: string; code?: string; filePath?: string; range?: { startLine: number; endLine: number } };
    const lang = c.language ?? '';
    const ref = c.filePath
      ? `\n<!-- source: ${c.filePath}${c.range ? `:${c.range.startLine}-${c.range.endLine}` : ''} -->`
      : '';
    return `\`\`\`${lang}\n${c.code ?? ''}\n\`\`\`${ref}\n`;
  }

  if (block.blockType === 'decision') {
    const c = content as { title?: string; decision?: string; rationale?: string; alternatives?: string[] };
    const lines = [`**Decision: ${c.title ?? ''}**`, '', c.decision ?? ''];
    if (c.rationale) lines.push('', `*Rationale:* ${c.rationale}`);
    if (c.alternatives?.length) {
      lines.push('', '*Alternatives considered:*');
      c.alternatives.forEach(a => lines.push(`- ${a}`));
    }
    return lines.join('\n') + '\n';
  }

  if (block.blockType === 'risk') {
    const c = content as { title?: string; description?: string; severity?: string; mitigation?: string };
    const lines = [`**Risk: ${c.title ?? ''}**`];
    if (c.severity) lines.push(`Severity: ${c.severity}`);
    if (c.description) lines.push('', c.description);
    if (c.mitigation) lines.push('', `*Mitigation:* ${c.mitigation}`);
    return lines.join('\n') + '\n';
  }

  // diagram / task / fallback — render as markdown fragment if string
  if (block.contentFormat === 'markdown_fragment' && typeof content === 'string') {
    return content + '\n';
  }

  return '';
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
