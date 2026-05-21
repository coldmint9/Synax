import { extractContextSignals, type ExtractContextSignalsResponse } from '../analyzer-client.js';
import type { AgentLoopRecord, ContextBindingRelation, ContextSignalKind } from '../contracts/context.js';
import type { CoordForest } from '../contracts/forest.js';
import { contextService, type ContextService } from './context-service.js';

type Extractor = (input: {
  projectId: string;
  loopRecord: AgentLoopRecord;
  forest: CoordForest;
  contextIndex: ReturnType<ContextService['getCoordinatesContextIndex']>;
  locale?: 'zh' | 'en';
  workDir?: string | null;
}) => Promise<ExtractContextSignalsResponse>;

const SIGNAL_KINDS = new Set<ContextSignalKind>([
  'decision',
  'risk',
  'constraint',
  'evidence',
  'artifact',
  'correction',
  'insight',
]);

const RELATIONS = new Set<ContextBindingRelation>([
  'uses',
  'references',
  'constrains',
  'resolves',
  'produces',
  'contains',
  'mentions',
  'discusses',
  'creates',
  'modifies',
]);

function compact(text: string, max = 1600): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > max ? `${normalized.slice(0, max - 1).trim()}…` : normalized;
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0.7;
  return Math.max(0, Math.min(1, value));
}

function isMechanicalNoise(text: string): boolean {
  const normalized = compact(text, 260).toLowerCase();
  if (!normalized) return true;
  if (/^tool\s+tool_[a-z0-9-]+:\s*(completed|started|failed)?\.?$/i.test(normalized)) return true;
  if (/^tool\s+(call|result)\s+tool_[a-z0-9-]+/i.test(normalized)) return true;
  if (/^run completed(?:\s*\([^)]*\))?\.?$/i.test(normalized)) return true;
  if (/^touched files:\s*/i.test(normalized)) return true;
  if (/^context snapshot\s+/i.test(normalized)) return true;
  return false;
}

export class SynapseContextAgentService {
  constructor(
    private readonly service: ContextService = contextService,
    private readonly extractor: Extractor = extractContextSignals,
  ) {}

  async processAgentLoop(input: {
    projectId: string;
    loopRecord: AgentLoopRecord;
    actorId?: string | null;
    locale?: 'zh' | 'en';
    workDir?: string | null;
  }): Promise<{ signalCount: number; handoffCount: number; warnings: string[] }> {
    const { projectId, loopRecord } = input;
    if (!loopRecord.nodeId) return { signalCount: 0, handoffCount: 0, warnings: ['loop has no source node'] };
    const state = this.service.getCoordinatesState(projectId);
    if (!state?.forest) {
      this.recordFailure(projectId, loopRecord, 'coordinates forest not found', input.actorId);
      return { signalCount: 0, handoffCount: 0, warnings: ['coordinates forest not found'] };
    }
    try {
      const contextIndex = this.service.getCoordinatesContextIndex(projectId);
      const result = await this.extractor({
        projectId,
        loopRecord,
        forest: state.forest,
        contextIndex,
        locale: input.locale ?? 'zh',
        workDir: input.workDir ?? null,
      });
      return this.persistExtraction({
        projectId,
        loopRecord,
        forest: state.forest,
        result,
        actorId: input.actorId ?? 'agent',
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.recordFailure(projectId, loopRecord, message, input.actorId);
      return { signalCount: 0, handoffCount: 0, warnings: [message] };
    }
  }

  persistExtraction(input: {
    projectId: string;
    loopRecord: AgentLoopRecord;
    forest: CoordForest;
    result: ExtractContextSignalsResponse;
    actorId?: string | null;
  }): { signalCount: number; handoffCount: number; warnings: string[] } {
    const warnings = [...(input.result.warnings ?? [])];
    const sourceNodeId = input.loopRecord.nodeId;
    if (!sourceNodeId) return { signalCount: 0, handoffCount: 0, warnings: [...warnings, 'loop has no source node'] };
    const titleToSignalId = new Map<string, { id: string; blockId: string }>();
    let signalCount = 0;
    for (const [idx, raw] of (input.result.signals ?? []).slice(0, 5).entries()) {
      if (!raw || !SIGNAL_KINDS.has(raw.kind)) {
        warnings.push('dropped invalid signal kind');
        continue;
      }
      const title = compact(raw.title ?? '', 240);
      const content = compact(raw.content ?? '', 2000);
      if (!title || !content) {
        warnings.push('dropped empty signal');
        continue;
      }
      if (isMechanicalNoise(`${title} ${raw.summary ?? ''} ${content}`)) {
        warnings.push(`dropped mechanical signal: ${title}`);
        continue;
      }
      const block = this.service.createContextBlock({
        projectId: input.projectId,
        kind: raw.kind === 'insight' ? 'evidence' : raw.kind,
        title,
        content,
        sourceType: 'context_signal',
        sourceId: `${input.loopRecord.id}:${idx + 1}:${raw.kind}`,
        metadata: {
          signalKind: raw.kind,
          loopRecordId: input.loopRecord.id,
          runId: input.loopRecord.runId,
          nodeId: sourceNodeId,
          tags: raw.tags ?? [],
          sourceLinks: raw.sourceLinks ?? [],
        },
        createdBy: input.actorId ?? 'agent',
      });
      const signal = this.service.createContextSignal({
        projectId: input.projectId,
        blockId: block.id,
        sourceType: 'agent_loop_record',
        sourceId: input.loopRecord.id,
        sourceNodeId,
        sourceRunId: input.loopRecord.runId,
        kind: raw.kind,
        title,
        summary: compact(raw.summary || content, 360),
        content,
        confidence: clamp01(raw.confidence),
        tags: (raw.tags ?? []).slice(0, 12),
        sourceLinks: (raw.sourceLinks ?? []).slice(0, 12),
        metadata: { loopRecordId: input.loopRecord.id, extraction: 'agentic-v1' },
        createdBy: input.actorId ?? 'agent',
      });
      this.service.createContextBinding({
        projectId: input.projectId,
        blockId: block.id,
        targetKind: 'node',
        targetId: sourceNodeId,
        relation: 'produces',
        confidence: signal.confidence,
        metadata: { signalId: signal.id, loopRecordId: input.loopRecord.id },
        createdBy: input.actorId ?? 'agent',
      });
      this.service.createContextBinding({
        projectId: input.projectId,
        blockId: block.id,
        targetKind: 'run',
        targetId: input.loopRecord.runId,
        relation: 'produces',
        confidence: signal.confidence,
        metadata: { signalId: signal.id, loopRecordId: input.loopRecord.id },
        createdBy: input.actorId ?? 'agent',
      });
      titleToSignalId.set(title.toLowerCase(), { id: signal.id, blockId: block.id });
      signalCount += 1;
    }

    let handoffCount = 0;
    for (const raw of (input.result.handoffs ?? []).slice(0, 8)) {
      const targetNodeId = raw.targetNodeId;
      const signalRef = titleToSignalId.get((raw.signalTitle ?? '').trim().toLowerCase());
      if (!signalRef) {
        warnings.push(`dropped handoff for unknown signal: ${raw.signalTitle}`);
        continue;
      }
      if (!targetNodeId || targetNodeId === sourceNodeId || !input.forest.nodes[targetNodeId]) {
        warnings.push(`dropped handoff for invalid target: ${targetNodeId}`);
        continue;
      }
      if (!RELATIONS.has(raw.relation)) {
        warnings.push(`dropped handoff for invalid relation: ${raw.relation}`);
        continue;
      }
      if (!raw.reason?.trim()) {
        warnings.push('dropped handoff with empty reason');
        continue;
      }
      this.service.createDisclosureSuggestion({
        projectId: input.projectId,
        signalId: signalRef.id,
        sourceNodeId,
        targetNodeId,
        relation: raw.relation,
        confidence: clamp01(raw.confidence),
        reason: compact(raw.reason, 360),
        metadata: { extraction: 'agentic-v1' },
        createdBy: input.actorId ?? 'agent',
      });
      handoffCount += 1;
    }
    return { signalCount, handoffCount, warnings };
  }

  private recordFailure(
    projectId: string,
    loopRecord: AgentLoopRecord,
    reason: string,
    actorId?: string | null,
  ): void {
    this.service.appendCoordEvent({
      projectId,
      type: 'context_signal_extraction_failed',
      nodeId: loopRecord.nodeId,
      runId: loopRecord.runId,
      payload: { loopRecordId: loopRecord.id, reason },
      actorId: actorId ?? 'agent',
    });
  }
}

export const synapseContextAgentService = new SynapseContextAgentService();
