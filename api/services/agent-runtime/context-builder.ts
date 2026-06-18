import type { AgentContextBlock, AgentContextBundle, BuildContextRequest } from './contracts.js';
import { contextService } from '../context/context-service.js';
import { makeRuntimeId, nowIso } from './runtime-ids.js';
import { agentRuntimeStore, type AgentRuntimeStore } from './session-store.js';
import { resolveSessionWorkDir } from './tools/workspace.js';
import { buildSynaxRuntimeBlocks } from './synax/synax-runtime-context.js';

export class AgentContextBuilder {
  constructor(private readonly store: AgentRuntimeStore = agentRuntimeStore) {}

  build(projectId: string, input: BuildContextRequest & { sessionId?: string } = {}): AgentContextBundle {
    const include = input.include ?? ['coord', 'memory', 'graph', 'review'];
    const warnings: string[] = [];
    const blocks: AgentContextBlock[] = [];

    if (input.sessionId) {
      try {
        const workDir = resolveSessionWorkDir(input.sessionId, projectId);
        blocks.push(...buildSynaxRuntimeBlocks(projectId, workDir));
      } catch (error) {
        warnings.push(`Synax runtime context unavailable: ${error instanceof Error ? error.message : String(error)}`);
      }
    }

    for (const kind of include) {
      const normalizedKind =
        kind === 'coord' ? ('goal' as const) : kind === 'graph' ? ('code' as const) : kind;
      if (kind === 'graph' && blocks.some((b) => b.sourceType === 'code-map')) {
        continue;
      }
      blocks.push({
        id: makeRuntimeId('acblk'),
        kind: normalizedKind,
        title: `${kind} context`,
        content: this.describeContext(projectId, kind, input.nodeId ?? null),
        sourceType: kind,
        sourceId: input.nodeId ?? projectId,
      });
    }

    if (!input.nodeId) warnings.push('No CoordForest node id supplied; bundle is project-level.');
    try {
      const suggestions = contextService.suggestContextBlocks({
        projectId,
        nodeId: input.nodeId ?? undefined,
        limit: 5,
      });
      for (const item of suggestions) {
        const block = item.block;
        blocks.push({
          id: makeRuntimeId('acblk'),
          kind: block.kind === 'artifact' ? 'code' : block.kind === 'decision' ? 'memory' : 'system',
          title: block.title,
          content: block.content,
          sourceType: block.sourceType ?? 'context',
          sourceId: block.id,
        });
      }
      if (suggestions.length === 0) warnings.push('No stored Synax context suggestions matched this request.');
    } catch (error) {
      warnings.push(`Synax context adapter unavailable: ${error instanceof Error ? error.message : String(error)}`);
    }

    const bundle: AgentContextBundle = {
      id: makeRuntimeId('acb'),
      projectId,
      sessionId: input.sessionId ?? null,
      nodeId: input.nodeId ?? null,
      profileId: input.profileId ?? null,
      blocks,
      citations: input.nodeId ? [{ id: makeRuntimeId('cite'), nodeId: input.nodeId }] : [],
      warnings,
      createdAt: nowIso(),
    };
    return this.store.saveContextBundle(bundle);
  }

  private describeContext(projectId: string, kind: NonNullable<BuildContextRequest['include']>[number], nodeId: string | null): string {
    if (kind === 'coord') return nodeId ? `CoordForest node ${nodeId} in project ${projectId}.` : `Project ${projectId} coordination context.`;
    if (kind === 'memory') {
      try {
        const memories = contextService.listMemories(projectId, { limit: 5 });
        return memories.items.length
          ? memories.items.map((memory) => `${memory.title}: ${memory.content}`).join('\n')
          : 'No active project memories found.';
      } catch {
        return 'Project memory adapter unavailable.';
      }
    }
    if (kind === 'graph') return 'Use the Code Map block when present; otherwise run a code-map scan.';
    if (kind === 'review') return 'Review evidence hook prepared for completed action and goal review results.';
    return 'Additional context hook prepared.';
  }
}

export const agentContextBuilder = new AgentContextBuilder();
