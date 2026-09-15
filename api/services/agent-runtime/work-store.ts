import type { RuntimeContentPart } from './content-parts.js';
import { getRawSqlite } from '../../db/index.js';
import { agentRuntimeStore as store } from './session-store.js';
import { makeRuntimeId, nowIso } from './runtime-ids.js';

export interface WorkEvidence {
  criterion: string;
  summary: string;
  toolCallIds?: string[];
  artifactIds?: string[];
}
export interface WorkCheckpoint {
  throughStepId: string;
  summary: string;
  createdAt: string;
}
export interface VerificationRecord {
  runId: string | null;
  toolCallId: string;
  criterion: string;
  purpose: string;
  command: string;
  workdir: string;
  scope: string[];
  fingerprint: string;
  changeVersion: number;
  status: 'success' | 'failed' | 'interrupted';
  startedAt: string;
  completedAt: string;
  external: boolean;
  risk?: string;
}
export interface WorkLedgerEntry {
  /** `${toolId}:${argsHash}` — identity of a call, not of its result. */
  key: string;
  /** Digest of the newest outcome for this call; a changed outcome is new information. */
  outcome: string;
  count: number;
  at: string;
}
export interface WorkRecord {
  id: string;
  sessionId: string;
  parentWorkId: string | null;
  objective: string;
  requirements: Array<{ messageId: string; text: string; contentParts?: RuntimeContentPart[] }>;
  status: 'active' | 'waiting' | 'closing' | 'completed' | 'blocked' | 'cancelled';
  planRevision: number | null;
  planSnapshot?: Record<string, unknown>;
  acceptanceCriteria: string[];
  evidence: WorkEvidence[];
  remaining: string[];
  nextAction: string | null;
  expectedEvidence: string | null;
  progressVersion: number;
  changeVersion: number;
  ledger: WorkLedgerEntry[];
  observedSteps: string[];
  noProgressSteps: number;
  decisionFailures: number;
  checkpoint: WorkCheckpoint | null;
  verifications: VerificationRecord[];
  changedPaths: string[];
  hasChanges: boolean;
  legacyEvidenceIncomplete: boolean;
  result: string | null;
  reason: string | null;
  createdAt: string;
  updatedAt: string;
}

export const workStore = {
  get(id: string): WorkRecord | null {
    const row = getRawSqlite().prepare('SELECT payload_json FROM agent_runtime_work WHERE id = ?').get(id) as { payload_json: string } | undefined;
    if (!row) return null;
    const work = JSON.parse(row.payload_json) as WorkRecord;
    // Records persisted before the action ledger existed carry no novelty history.
    if (!Array.isArray(work.ledger)) work.ledger = [];
    if (typeof work.noProgressSteps !== 'number') work.noProgressSteps = 0;
    if (typeof work.decisionFailures !== 'number') work.decisionFailures = 0;
    return work;
  },
  current(sessionId: string): WorkRecord | null {
    const id = store.getSession(sessionId).sessionMetadata?.activeWorkId;
    const work = typeof id === 'string' ? this.get(id) : null;
    return work?.sessionId === sessionId ? work : null;
  },
  save(work: WorkRecord): WorkRecord {
    work.updatedAt = nowIso();
    getRawSqlite().prepare('INSERT INTO agent_runtime_work (id, session_id, payload_json, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET payload_json=excluded.payload_json, updated_at=excluded.updated_at')
      .run(work.id, work.sessionId, JSON.stringify(work), work.updatedAt);
    return work;
  },
  create(sessionId: string, objective: string, legacy = false): WorkRecord {
    const session = store.getSession(sessionId);
    const parent = session.parentSessionId ? this.current(session.parentSessionId) : null;
    const work: WorkRecord = {
      id: makeRuntimeId('work'), sessionId, parentWorkId: parent?.id ?? null, objective,
      requirements: [], status: 'active', planRevision: null, acceptanceCriteria: [], evidence: [], remaining: [],
      nextAction: null, expectedEvidence: null, progressVersion: 0, changeVersion: 0,
      ledger: [], observedSteps: [], noProgressSteps: 0, decisionFailures: 0,
      checkpoint: null, verifications: [], changedPaths: [], hasChanges: false, legacyEvidenceIncomplete: legacy,
      result: null, reason: null, createdAt: nowIso(), updatedAt: nowIso(),
    };
    this.save(work);
    store.updateSessionMetadata(sessionId, { activeWorkId: work.id });
    return work;
  },
};
