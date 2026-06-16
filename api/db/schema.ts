// ---------------------------------------------------------------------------
// api/db/schema.ts — Drizzle ORM 表定义（上下文管理系统）
//
// 与 migrations/0000_init_context.sql 保持结构一致。Drizzle 用于类型推导
// 与查询构建，建表通过原始 SQL 迁移文件完成（保留对 FTS5/触发器/检查约束
// 等 Drizzle 不完全覆盖的 SQLite 特性的完整控制）。
// ---------------------------------------------------------------------------

import {
  sqliteTable,
  text,
  integer,
  real,
  uniqueIndex,
  primaryKey,
} from 'drizzle-orm/sqlite-core';

export const contextSessions = sqliteTable('context_sessions', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  userId: text('user_id').notNull(),
  status: text('status').notNull().default('active'), // active | archived | expired
  title: text('title'),
  summary: text('summary'),
  tokenCount: integer('token_count').notNull().default(0),
  entryCount: integer('entry_count').notNull().default(0),
  sourceAgent: text('source_agent'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  expiresAt: text('expires_at'),
  archivedAt: text('archived_at'),
});

export const contextEntries = sqliteTable('context_entries', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  projectId: text('project_id').notNull(),
  sequence: integer('sequence').notNull(),
  role: text('role').notNull(), // user | assistant | system | tool
  content: text('content').notNull(),
  contentType: text('content_type').notNull().default('text'),
  tokenEstimate: integer('token_estimate').notNull().default(0),
  metadata: text('metadata').notNull().default('{}'),
  parentEntryId: text('parent_entry_id'),
  createdAt: text('created_at').notNull(),
});

export const contextSnapshots = sqliteTable('context_snapshots', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  projectId: text('project_id').notNull(),
  label: text('label'),
  fromSequence: integer('from_sequence').notNull(),
  toSequence: integer('to_sequence').notNull(),
  entryCount: integer('entry_count').notNull(),
  compressedContent: text('compressed_content'),
  diffBaseId: text('diff_base_id'),
  createdAt: text('created_at').notNull(),
  createdBy: text('created_by'),
});

export const projectMemories = sqliteTable('project_memories', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  memoryType: text('memory_type').notNull(), // pattern | decision | preference | convention | insight | risk
  title: text('title').notNull(),
  content: text('content').notNull(),
  sourceSessionId: text('source_session_id'),
  sourceEntryId: text('source_entry_id'),
  tags: text('tags').notNull().default('[]'),
  confidence: real('confidence').notNull().default(1.0),
  accessCount: integer('access_count').notNull().default(0),
  referencesJson: text('references_json').notNull().default('{}'),
  status: text('status').notNull().default('active'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  expiresAt: text('expires_at'),
});

export const contextLinks = sqliteTable(
  'context_links',
  {
    id: text('id').primaryKey(),
    entryId: text('entry_id').notNull(),
    nodeId: text('node_id').notNull(),
    projectId: text('project_id').notNull(),
    linkType: text('link_type').notNull(),
    confidence: real('confidence').notNull().default(1.0),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    uniq: uniqueIndex('uniq_entry_node_link').on(t.entryId, t.nodeId, t.linkType),
  }),
);

export const coordinatesState = sqliteTable('coordinates_state', {
  projectId: text('project_id').primaryKey(),
  snapshotJson: text('snapshot_json').notNull(),
  revision: integer('revision').notNull().default(0),
  updatedAt: text('updated_at').notNull(),
  updatedBy: text('updated_by'),
});

export const contextBlocks = sqliteTable('context_blocks', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  kind: text('kind').notNull(),
  title: text('title').notNull(),
  content: text('content').notNull(),
  status: text('status').notNull().default('active'),
  sourceType: text('source_type'),
  sourceId: text('source_id'),
  metadataJson: text('metadata_json').notNull().default('{}'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  createdBy: text('created_by'),
});

export const contextBindings = sqliteTable(
  'context_bindings',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    blockId: text('block_id').notNull(),
    targetKind: text('target_kind').notNull(),
    targetId: text('target_id').notNull(),
    relation: text('relation').notNull(),
    confidence: real('confidence').notNull().default(1.0),
    metadataJson: text('metadata_json').notNull().default('{}'),
    createdAt: text('created_at').notNull(),
    createdBy: text('created_by'),
  },
  (t) => ({
    uniq: uniqueIndex('uniq_context_binding').on(
      t.projectId,
      t.blockId,
      t.targetKind,
      t.targetId,
      t.relation,
    ),
  }),
);

export const contextBundles = sqliteTable('context_bundles', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  title: text('title').notNull(),
  blockIdsJson: text('block_ids_json').notNull().default('[]'),
  metadataJson: text('metadata_json').notNull().default('{}'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  createdBy: text('created_by'),
});

export const contextRunSnapshots = sqliteTable(
  'context_run_snapshots',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    nodeId: text('node_id').notNull(),
    runId: text('run_id').notNull(),
    bundleId: text('bundle_id'),
    inputBlockIdsJson: text('input_block_ids_json').notNull().default('[]'),
    prompt: text('prompt').notNull(),
    frozenContextJson: text('frozen_context_json').notNull().default('[]'),
    createdAt: text('created_at').notNull(),
    createdBy: text('created_by'),
  },
  (t) => ({
    uniq: uniqueIndex('uniq_context_run_snapshot').on(t.projectId, t.runId),
  }),
);

export const coordEventLog = sqliteTable(
  'coord_event_log',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    revision: integer('revision').notNull(),
    type: text('type').notNull(),
    nodeId: text('node_id'),
    runId: text('run_id'),
    contextBlockIdsJson: text('context_block_ids_json').notNull().default('[]'),
    causedByEventIdsJson: text('caused_by_event_ids_json').notNull().default('[]'),
    payloadJson: text('payload_json').notNull().default('{}'),
    actorId: text('actor_id'),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    uniq: uniqueIndex('uniq_coord_event_project_revision').on(t.projectId, t.revision),
  }),
);

export const agentConversationTurns = sqliteTable(
  'agent_conversation_turns',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    nodeId: text('node_id'),
    runId: text('run_id').notNull(),
    userId: text('user_id'),
    rawInput: text('raw_input').notNull(),
    contextSnapshotId: text('context_snapshot_id'),
    status: text('status').notNull().default('running'),
    metadataJson: text('metadata_json').notNull().default('{}'),
    createdAt: text('created_at').notNull(),
    completedAt: text('completed_at'),
  },
  (t) => ({
    uniq: uniqueIndex('idx_agent_turn_project_run').on(t.projectId, t.runId),
  }),
);

export const agentLoopRecords = sqliteTable(
  'agent_loop_records',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    turnId: text('turn_id').notNull(),
    nodeId: text('node_id'),
    runId: text('run_id').notNull(),
    provider: text('provider').notNull(),
    status: text('status').notNull(),
    summary: text('summary'),
    finalOutput: text('final_output'),
    contextSnapshotId: text('context_snapshot_id'),
    transcriptJson: text('transcript_json').notNull().default('{}'),
    fileChangesJson: text('file_changes_json').notNull().default('[]'),
    metadataJson: text('metadata_json').notNull().default('{}'),
    startedAt: text('started_at').notNull(),
    completedAt: text('completed_at'),
  },
  (t) => ({
    uniq: uniqueIndex('idx_agent_loop_project_run').on(t.projectId, t.runId),
  }),
);

export const agentLoopSteps = sqliteTable(
  'agent_loop_steps',
  {
    id: text('id').primaryKey(),
    loopId: text('loop_id').notNull(),
    projectId: text('project_id').notNull(),
    runId: text('run_id').notNull(),
    sequence: integer('sequence').notNull(),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    content: text('content').notNull(),
    payloadJson: text('payload_json').notNull().default('{}'),
    metadataJson: text('metadata_json').notNull().default('{}'),
    createdAt: text('created_at').notNull(),
  },
  (t) => ({
    uniq: uniqueIndex('idx_agent_loop_step_sequence').on(t.loopId, t.sequence),
  }),
);

export const contextSignals = sqliteTable(
  'context_signals',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    blockId: text('block_id').notNull(),
    sourceType: text('source_type').notNull(),
    sourceId: text('source_id').notNull(),
    sourceNodeId: text('source_node_id'),
    sourceRunId: text('source_run_id'),
    kind: text('kind').notNull(),
    title: text('title').notNull(),
    summary: text('summary').notNull(),
    content: text('content').notNull(),
    confidence: real('confidence').notNull().default(0.7),
    tagsJson: text('tags_json').notNull().default('[]'),
    sourceLinksJson: text('source_links_json').notNull().default('[]'),
    metadataJson: text('metadata_json').notNull().default('{}'),
    createdAt: text('created_at').notNull(),
    createdBy: text('created_by'),
  },
  (t) => ({
    uniq: uniqueIndex('uniq_context_signal_source_kind_title').on(
      t.projectId,
      t.sourceType,
      t.sourceId,
      t.kind,
      t.title,
    ),
  }),
);

export const contextDisclosureSuggestions = sqliteTable(
  'context_disclosure_suggestions',
  {
    id: text('id').primaryKey(),
    projectId: text('project_id').notNull(),
    signalId: text('signal_id').notNull(),
    sourceNodeId: text('source_node_id'),
    targetNodeId: text('target_node_id').notNull(),
    relation: text('relation').notNull(),
    confidence: real('confidence').notNull().default(0.7),
    reason: text('reason').notNull(),
    status: text('status').notNull().default('pending'),
    metadataJson: text('metadata_json').notNull().default('{}'),
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
    decidedBy: text('decided_by'),
    decidedAt: text('decided_at'),
  },
  (t) => ({
    uniq: uniqueIndex('uniq_context_disclosure_target').on(
      t.projectId,
      t.signalId,
      t.targetNodeId,
      t.relation,
    ),
  }),
);

// ── 两级配置表（Global + Project）──────────────────────────────────────────

export const globalConfig = sqliteTable('global_config', {
  id: integer('id').primaryKey(),
  version: integer('version').notNull().default(1),
  configJson: text('config_json').notNull(),
  updatedAt: text('updated_at').notNull(),
  updatedBy: text('updated_by').notNull(),
});

export const projectConfig = sqliteTable('project_config', {
  projectId: text('project_id').primaryKey(),
  version: integer('version').notNull().default(1),
  configJson: text('config_json').notNull(),
  updatedAt: text('updated_at').notNull(),
  updatedBy: text('updated_by').notNull(),
});

export const metaTable = sqliteTable('_meta', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});

// ── Shared Agent Runtime tables ────────────────────────────────────────────

export const agentRuntimeSessions = sqliteTable('agent_runtime_sessions', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  parentSessionId: text('parent_session_id'),
  childSessionIdsJson: text('child_session_ids_json').notNull().default('[]'),
  nodeId: text('node_id'),
  profileId: text('profile_id').notNull(),
  status: text('status').notNull(),
  prompt: text('prompt').notNull(),
  contextSnapshotId: text('context_snapshot_id'),
  thinkingMode: text('thinking_mode').notNull(),
  permissionRulesJson: text('permission_rules_json').notNull().default('[]'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  completedAt: text('completed_at'),
  resultSummary: text('result_summary'),
  blockedReason: text('blocked_reason'),
  skillIdsJson: text('skill_ids_json').notNull().default('[]'),
  activeRunId: text('active_run_id'),
  pendingResumeToken: text('pending_resume_token'),
});

export const agentRuntimeMessages = sqliteTable('agent_runtime_messages', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  projectId: text('project_id').notNull(),
  sequence: integer('sequence').notNull().default(0),
  turnId: text('turn_id'),
  runId: text('run_id'),
  stepId: text('step_id'),
  role: text('role').notNull(),
  content: text('content').notNull(),
  providerId: text('provider_id'),
  modelId: text('model_id'),
  toolCallId: text('tool_call_id'),
  usageJson: text('usage_json').notNull().default('{}'),
  metadataJson: text('metadata_json').notNull().default('{}'),
  createdAt: text('created_at').notNull(),
});

export const agentRuntimeEvents = sqliteTable('agent_runtime_events', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  type: text('type').notNull(),
  timestamp: text('timestamp').notNull(),
  visibility: text('visibility').notNull(),
  summary: text('summary').notNull(),
  payloadJson: text('payload_json').notNull().default('{}'),
});

export const agentRuntimeToolCalls = sqliteTable('agent_runtime_tool_calls', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  runId: text('run_id'),
  stepId: text('step_id'),
  modelToolCallId: text('model_tool_call_id'),
  toolId: text('tool_id').notNull(),
  category: text('category').notNull(),
  mutability: text('mutability').notNull().default('read'),
  argsHash: text('args_hash').notNull().default(''),
  inputSummary: text('input_summary').notNull(),
  inputRefJson: text('input_ref_json'),
  outputSummary: text('output_summary'),
  outputRefJson: text('output_ref_json'),
  status: text('status').notNull(),
  permissionDecisionId: text('permission_decision_id'),
  startedAt: text('started_at').notNull(),
  endedAt: text('ended_at'),
  error: text('error'),
});

export const agentRuntimePermissions = sqliteTable('agent_runtime_permissions', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  runId: text('run_id'),
  stepId: text('step_id'),
  toolCallId: text('tool_call_id'),
  coarseCategory: text('coarse_category').notNull(),
  internalGate: text('internal_gate').notNull(),
  action: text('action').notNull(),
  reason: text('reason').notNull(),
  patternsJson: text('patterns_json').notNull().default('[]'),
  userReply: text('user_reply'),
  createdAt: text('created_at').notNull(),
  resolvedAt: text('resolved_at'),
  resumeToken: text('resume_token'),
  metadataJson: text('metadata_json').notNull().default('{}'),
});

export const agentRuntimeRuns = sqliteTable('agent_runtime_runs', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  status: text('status').notNull(),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'),
  triggerMessageId: text('trigger_message_id'),
  currentStep: integer('current_step').notNull().default(0),
  stopReason: text('stop_reason'),
  model: text('model'),
  metadataJson: text('metadata_json').notNull().default('{}'),
});

export const agentRuntimeRunSteps = sqliteTable('agent_runtime_run_steps', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  sessionId: text('session_id').notNull(),
  stepIndex: integer('step_index').notNull(),
  status: text('status').notNull(),
  model: text('model'),
  startedAt: text('started_at').notNull(),
  completedAt: text('completed_at'),
  finishReason: text('finish_reason'),
  metadataJson: text('metadata_json').notNull().default('{}'),
});

export const agentRuntimeRunParts = sqliteTable('agent_runtime_run_parts', {
  id: text('id').primaryKey(),
  runId: text('run_id').notNull(),
  stepId: text('step_id').notNull(),
  sessionId: text('session_id').notNull(),
  kind: text('kind').notNull(),
  sequence: integer('sequence').notNull(),
  content: text('content').notNull(),
  toolCallId: text('tool_call_id'),
  metadataJson: text('metadata_json').notNull().default('{}'),
  createdAt: text('created_at').notNull(),
});

export const agentRuntimeArtifacts = sqliteTable('agent_runtime_artifacts', {
  id: text('id').primaryKey(),
  sessionId: text('session_id').notNull(),
  kind: text('kind').notNull(),
  title: text('title').notNull(),
  summary: text('summary').notNull(),
  sourceRefsJson: text('source_refs_json').notNull().default('[]'),
  risk: text('risk').notNull(),
  metadataJson: text('metadata_json').notNull().default('{}'),
  createdAt: text('created_at').notNull(),
});

export const agentRuntimeContextBundles = sqliteTable('agent_runtime_context_bundles', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  sessionId: text('session_id'),
  nodeId: text('node_id'),
  profileId: text('profile_id'),
  blocksJson: text('blocks_json').notNull().default('[]'),
  citationsJson: text('citations_json').notNull().default('[]'),
  warningsJson: text('warnings_json').notNull().default('[]'),
  createdAt: text('created_at').notNull(),
});

export type GlobalConfigRow = typeof globalConfig.$inferSelect;
export type NewGlobalConfigRow = typeof globalConfig.$inferInsert;
export type ProjectConfigRow = typeof projectConfig.$inferSelect;
export type NewProjectConfigRow = typeof projectConfig.$inferInsert;

export type ContextSessionRow = typeof contextSessions.$inferSelect;
export type NewContextSessionRow = typeof contextSessions.$inferInsert;
export type ContextEntryRow = typeof contextEntries.$inferSelect;
export type NewContextEntryRow = typeof contextEntries.$inferInsert;
export type ContextSnapshotRow = typeof contextSnapshots.$inferSelect;
export type NewContextSnapshotRow = typeof contextSnapshots.$inferInsert;
export type ProjectMemoryRow = typeof projectMemories.$inferSelect;
export type NewProjectMemoryRow = typeof projectMemories.$inferInsert;
export type ContextLinkRow = typeof contextLinks.$inferSelect;
export type NewContextLinkRow = typeof contextLinks.$inferInsert;
export type CoordinatesStateRow = typeof coordinatesState.$inferSelect;
export type NewCoordinatesStateRow = typeof coordinatesState.$inferInsert;
export type ContextBlockRow = typeof contextBlocks.$inferSelect;
export type NewContextBlockRow = typeof contextBlocks.$inferInsert;
export type ContextBindingRow = typeof contextBindings.$inferSelect;
export type NewContextBindingRow = typeof contextBindings.$inferInsert;
export type ContextBundleRow = typeof contextBundles.$inferSelect;
export type NewContextBundleRow = typeof contextBundles.$inferInsert;
export type ContextRunSnapshotRow = typeof contextRunSnapshots.$inferSelect;
export type NewContextRunSnapshotRow = typeof contextRunSnapshots.$inferInsert;
export type CoordEventLogRow = typeof coordEventLog.$inferSelect;
export type NewCoordEventLogRow = typeof coordEventLog.$inferInsert;
export type AgentConversationTurnRow = typeof agentConversationTurns.$inferSelect;
export type NewAgentConversationTurnRow = typeof agentConversationTurns.$inferInsert;
export type AgentLoopRecordRow = typeof agentLoopRecords.$inferSelect;
export type NewAgentLoopRecordRow = typeof agentLoopRecords.$inferInsert;
export type AgentLoopStepRow = typeof agentLoopSteps.$inferSelect;
export type NewAgentLoopStepRow = typeof agentLoopSteps.$inferInsert;
export type ContextSignalRow = typeof contextSignals.$inferSelect;
export type NewContextSignalRow = typeof contextSignals.$inferInsert;
export type ContextDisclosureSuggestionRow = typeof contextDisclosureSuggestions.$inferSelect;
export type NewContextDisclosureSuggestionRow = typeof contextDisclosureSuggestions.$inferInsert;

// ── Codebase Design Wiki tables ────────────────────────────────────────────

export const wikiSnapshots = sqliteTable('wiki_snapshots', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  branch: text('branch').notNull(),
  headCommitSha: text('head_commit_sha').notNull(),
  workingTreeHash: text('working_tree_hash').notNull(),
  repoIndexId: text('repo_index_id'),
  revision: integer('revision').notNull().default(1),
  status: text('status').notNull().default('ready'),
  documentIdsJson: text('document_ids_json').notNull().default('[]'),
  createdAt: text('created_at').notNull(),
  createdBy: text('created_by').notNull().default('system'),
});

export const wikiDocuments = sqliteTable('wiki_documents', {
  id: text('id').primaryKey(),
  snapshotId: text('snapshot_id').notNull(),
  projectId: text('project_id').notNull(),
  title: text('title').notNull(),
  docType: text('doc_type').notNull(),
  parentId: text('parent_id'),
  contentMd: text('content_md').notNull().default(''),
  referencesJson: text('references_json').notNull().default('[]'),
  searchText: text('search_text').notNull().default(''),
  pipelineStage: text('pipeline_stage').notNull().default('pending'),
  sortOrder: integer('sort_order').notNull().default(0),
  manualState: text('manual_state').notNull().default('none'),
  staleState: text('stale_state').notNull().default('fresh'),
  isSection: integer('is_section').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const wikiRefreshDrafts = sqliteTable('wiki_refresh_drafts', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  snapshotId: text('snapshot_id').notNull(),
  refreshTaskId: text('refresh_task_id'),
  documentId: text('document_id').notNull(),
  status: text('status').notNull().default('generating'),
  changesJson: text('changes_json').notNull().default('[]'),
  summary: text('summary'),
  sourceCommitSha: text('source_commit_sha'),
  createdAt: text('created_at').notNull(),
  expiresAt: text('expires_at'),
  decidedAt: text('decided_at'),
  decidedBy: text('decided_by'),
});

export const wikiRefreshTasks = sqliteTable('wiki_refresh_tasks', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  snapshotId: text('snapshot_id').notNull(),
  baseRepoIndexId: text('base_repo_index_id'),
  nextRepoIndexId: text('next_repo_index_id'),
  status: text('status').notNull().default('queued'),
  priority: text('priority').notNull().default('p1'),
  draftIdsJson: text('draft_ids_json').notNull().default('[]'),
  affectedDocumentIdsJson: text('affected_document_ids_json').notNull().default('[]'),
  errorMessage: text('error_message'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  completedAt: text('completed_at'),
});

export type WikiSnapshotRow = typeof wikiSnapshots.$inferSelect;
export type NewWikiSnapshotRow = typeof wikiSnapshots.$inferInsert;
export type WikiDocumentRow = typeof wikiDocuments.$inferSelect;
export type NewWikiDocumentRow = typeof wikiDocuments.$inferInsert;
export type WikiRefreshTaskRow = typeof wikiRefreshTasks.$inferSelect;
export type NewWikiRefreshTaskRow = typeof wikiRefreshTasks.$inferInsert;

export const wikiScanCache = sqliteTable('wiki_scan_cache', {
  projectId: text('project_id').primaryKey(),
  scanId: text('scan_id').notNull(),
  codeIndexJson: text('code_index_json').notNull(),
  communitiesJson: text('communities_json'),
  updatedAt: text('updated_at').notNull(),
});

export const wikiScanGitCache = sqliteTable('wiki_scan_git_cache', {
  projectId: text('project_id').notNull(),
  branch: text('branch').notNull(),
  headCommitSha: text('head_commit_sha').notNull(),
  workingTreeHash: text('working_tree_hash').notNull(),
  scanId: text('scan_id').notNull(),
  resultJson: text('result_json').notNull(),
  updatedAt: text('updated_at').notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.projectId, table.branch, table.headCommitSha, table.workingTreeHash] }),
}));

export type WikiScanGitCacheRow = typeof wikiScanGitCache.$inferSelect;
export type NewWikiScanGitCacheRow = typeof wikiScanGitCache.$inferInsert;

// ── Wiki Goals & Plans ────────────────────────────────────────────────────────

export type GoalAnchor = {
  type: 'heading' | 'selection'
  heading?: string
  quote?: string
}

export const wikiGoals = sqliteTable('wiki_goals', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  scope: text('scope').notNull().default('document'),
  documentId: text('document_id'),
  content: text('content').notNull(),
  anchorJson: text('anchor_json'),
  status: text('status').notNull().default('active'),
  planNodeId: text('plan_node_id'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  resolvedAt: text('resolved_at'),
});

export const wikiPlans = sqliteTable('wiki_plans', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  snapshotId: text('snapshot_id').notNull(),
  goalIdsJson: text('goal_ids_json').notNull().default('[]'),
  evaluationIdsJson: text('evaluation_ids_json').notNull().default('[]'),
  nodesJson: text('nodes_json').notNull().default('[]'),
  status: text('status').notNull().default('draft'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  confirmedAt: text('confirmed_at'),
});

export const wikiPlanNodes = sqliteTable('wiki_plan_nodes', {
  id: text('id').primaryKey(),
  planId: text('plan_id').notNull(),
  projectId: text('project_id').notNull(),
  title: text('title').notNull(),
  description: text('description').notNull().default(''),
  goalIdsJson: text('goal_ids_json').notNull().default('[]'),
  evaluationIdsJson: text('evaluation_ids_json').notNull().default('[]'),
  dependsOnJson: text('depends_on_json').notNull().default('[]'),
  expectedFilesJson: text('expected_files_json').notNull().default('[]'),
  status: text('status').notNull().default('pending'),
  sortOrder: integer('sort_order').notNull().default(0),
  reviewResult: text('review_result'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  completedAt: text('completed_at'),
});

export type WikiGoalRow = typeof wikiGoals.$inferSelect;
export type NewWikiGoalRow = typeof wikiGoals.$inferInsert;
export type WikiPlanRow = typeof wikiPlans.$inferSelect;
export type NewWikiPlanRow = typeof wikiPlans.$inferInsert;
export type WikiPlanNodeRow = typeof wikiPlanNodes.$inferSelect;
export type NewWikiPlanNodeRow = typeof wikiPlanNodes.$inferInsert;

export const wikiPlanNodeArtifacts = sqliteTable('wiki_plan_node_artifacts', {
  id: text('id').primaryKey(),
  nodeId: text('node_id').notNull(),
  planId: text('plan_id').notNull(),
  sessionId: text('session_id'),
  patchesJson: text('patches_json').notNull().default('[]'),
  executionLog: text('execution_log'),
  commitMessage: text('commit_message'),
  status: text('status').notNull().default('pending'),
  redoCount: integer('redo_count').notNull().default(0),
  redoFeedback: text('redo_feedback'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
});

export type WikiPlanNodeArtifactRow = typeof wikiPlanNodeArtifacts.$inferSelect;
export type NewWikiPlanNodeArtifactRow = typeof wikiPlanNodeArtifacts.$inferInsert;

export const wikiWriteBatches = sqliteTable('wiki_write_batches', {
  id: text('id').primaryKey(),
  snapshotId: text('snapshot_id').notNull(),
  projectId: text('project_id').notNull(),
  workDir: text('work_dir').notNull(),
  locale: text('locale').notNull().default('zh'),
  status: text('status').notNull().default('running'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  completedAt: text('completed_at'),
  error: text('error'),
});

export const wikiWriteQueueItems = sqliteTable('wiki_write_queue_items', {
  id: text('id').primaryKey(),
  batchId: text('batch_id').notNull(),
  snapshotId: text('snapshot_id').notNull(),
  projectId: text('project_id').notNull(),
  documentId: text('document_id').notNull(),
  documentTitle: text('document_title').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
  status: text('status').notNull().default('queued'),
  sessionId: text('session_id'),
  error: text('error'),
  createdAt: text('created_at').notNull(),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
});

export type WikiWriteBatchRow = typeof wikiWriteBatches.$inferSelect;
export type WikiWriteQueueItemRow = typeof wikiWriteQueueItems.$inferSelect;

export const wikiJobs = sqliteTable('wiki_jobs', {
  id: text('id').primaryKey(),
  projectId: text('project_id').notNull(),
  snapshotId: text('snapshot_id'),
  status: text('status').notNull().default('queued'),
  priority: integer('priority').notNull().default(0),
  workDir: text('work_dir').notNull(),
  locale: text('locale').notNull().default('zh'),
  createdAt: text('created_at').notNull(),
  startedAt: text('started_at'),
  completedAt: text('completed_at'),
  error: text('error'),
});

export type WikiJobRow = typeof wikiJobs.$inferSelect;
export type NewWikiJobRow = typeof wikiJobs.$inferInsert;
