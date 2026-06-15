import { wikiStore } from './wiki-store.js';

export async function countSnapshotWritingProgress(snapshotId: string): Promise<{
  doneDocs: number;
  totalDocs: number;
}> {
  const documents = await wikiStore.getDocumentsBySnapshot(snapshotId);
  const writable = documents.filter(d => !d.isSection);
  return {
    doneDocs: writable.filter(d => d.contentMd.trim().length > 0).length,
    totalDocs: writable.length,
  };
}
