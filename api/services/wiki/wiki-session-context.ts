import type {
  SessionReferenceAnchor,
  SessionWikiAttachMode,
} from "../agent-runtime/session-prompt.js";
import { searchWikiDocuments } from "./wiki-fts.js";
import { wikiStore } from "./wiki-store.js";
import type { WikiDocument } from "./contracts.js";

export type ResolvedSessionWikiContext = {
  mode: SessionWikiAttachMode;
  documentId: string | null;
  documentTitle: string | null;
  anchorJson: SessionReferenceAnchor | null;
  autoMatched: boolean;
};

export function isGeneratedWikiDocument(
  doc: Pick<WikiDocument, "isSection" | "contentMd">,
): boolean {
  return !doc.isSection && doc.contentMd.trim().length > 0;
}

export async function resolveSessionWikiContext(input: {
  projectId: string;
  content: string;
  mode: SessionWikiAttachMode;
  documentId?: string | null;
  anchorJson?: SessionReferenceAnchor | null;
}): Promise<ResolvedSessionWikiContext> {
  if (input.mode === "manual") {
    if (!input.documentId) {
      return {
        mode: "manual",
        documentId: null,
        documentTitle: null,
        anchorJson: input.anchorJson ?? null,
        autoMatched: false,
      };
    }
    const doc = await wikiStore.getDocument(input.documentId);
    if (!doc || !isGeneratedWikiDocument(doc)) {
      return {
        mode: "manual",
        documentId: null,
        documentTitle: null,
        anchorJson: null,
        autoMatched: false,
      };
    }
    return {
      mode: "manual",
      documentId: doc.id,
      documentTitle: doc.title,
      anchorJson: input.anchorJson ?? null,
      autoMatched: false,
    };
  }

  const results = searchWikiDocuments({
    projectId: input.projectId,
    query: input.content,
    limit: 8,
  });
  for (const hit of results) {
    const doc = await wikiStore.getDocument(hit.documentId);
    if (doc && isGeneratedWikiDocument(doc)) {
      return {
        mode: "auto",
        documentId: doc.id,
        documentTitle: doc.title,
        anchorJson: null,
        autoMatched: true,
      };
    }
  }

  return {
    mode: "auto",
    documentId: null,
    documentTitle: null,
    anchorJson: null,
    autoMatched: false,
  };
}
