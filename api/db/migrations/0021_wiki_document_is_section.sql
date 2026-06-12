-- Section nodes are folder headers in the document tree; they carry no markdown body.
ALTER TABLE wiki_documents ADD COLUMN is_section INTEGER NOT NULL DEFAULT 0;
