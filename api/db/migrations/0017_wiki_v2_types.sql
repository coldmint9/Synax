-- 0017_wiki_v2_types.sql
-- Migrate wiki docType and blockType to v2 schema.
-- SQLite doesn't enforce CHECK constraints on existing data by default,
-- so we update existing rows then add the new content_format default.

-- Map old docTypes to new ones
UPDATE wiki_documents SET doc_type = 'landscape' WHERE doc_type IN ('overview', 'directory_tree', 'tech_stack');
UPDATE wiki_documents SET doc_type = 'topology' WHERE doc_type = 'architecture';
UPDATE wiki_documents SET doc_type = 'module' WHERE doc_type IN ('module_spec', 'module_design');
UPDATE wiki_documents SET doc_type = 'data' WHERE doc_type = 'data_model';
UPDATE wiki_documents SET doc_type = 'flow' WHERE doc_type = 'flow';
-- 'api' docs merge into module
UPDATE wiki_documents SET doc_type = 'module' WHERE doc_type = 'api';

-- Map old blockTypes to new ones
UPDATE wiki_blocks SET block_type = 'prose' WHERE block_type = 'paragraph';
UPDATE wiki_blocks SET block_type = 'signature' WHERE block_type = 'code_ref';
-- 'task' blocks become prose (fallback)
UPDATE wiki_blocks SET block_type = 'prose' WHERE block_type = 'task';

-- Update content_format default for new blocks
UPDATE wiki_blocks SET content_format = 'structured_json' WHERE content_format = 'rich_text_json';

-- Flatten document hierarchy: set all parentId to null
UPDATE wiki_documents SET parent_id = NULL WHERE parent_id IS NOT NULL;
