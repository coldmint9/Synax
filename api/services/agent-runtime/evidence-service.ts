import type { EvidenceArtifact, EvidenceArtifactKind, RiskLevel } from './contracts.js';
import { makeRuntimeId, nowIso } from './runtime-ids.js';
import { agentRuntimeStore, type AgentRuntimeStore } from './session-store.js';

const MAX_SUMMARY_CHARS = 2_000;

export class EvidenceService {
  constructor(private readonly store: AgentRuntimeStore = agentRuntimeStore) {}

  append(input: {
    sessionId: string;
    kind: EvidenceArtifactKind;
    title: string;
    summary: string;
    sourceRefs?: EvidenceArtifact['sourceRefs'];
    risk?: RiskLevel;
    metadata?: Record<string, unknown>;
  }): EvidenceArtifact {
    const compacted = this.compactSummary(input.summary);
    return this.store.appendArtifact({
      id: makeRuntimeId('art'),
      sessionId: input.sessionId,
      kind: input.kind,
      title: input.title,
      summary: compacted.summary,
      sourceRefs: input.sourceRefs ?? [],
      risk: input.risk ?? 'unknown',
      createdAt: nowIso(),
      metadata: {
        ...(input.metadata ?? {}),
        compacted: compacted.compacted,
        originalLength: input.summary.length,
      },
    });
  }

  list(sessionId: string): EvidenceArtifact[] {
    return this.store.listArtifacts(sessionId);
  }

  compactSummary(summary: string): { summary: string; compacted: boolean } {
    if (summary.length <= MAX_SUMMARY_CHARS) return { summary, compacted: false };
    return {
      summary: `${summary.slice(0, MAX_SUMMARY_CHARS)}\n[output compacted: ${summary.length - MAX_SUMMARY_CHARS} chars omitted]`,
      compacted: true,
    };
  }
}

export const evidenceService = new EvidenceService();
