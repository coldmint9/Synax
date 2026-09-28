import type { ToolCallRecord } from './contracts.js';
import { agentRuntimeStore as store } from './session-store.js';
import { workStore, type VerificationRecord, type WorkRecord } from './work-store.js';
import { workspaceFingerprint } from './work-fingerprint.js';

/**
 * Single authority for "which runtime IDs may be cited as evidence".
 *
 * Prompt inventories, work.checkpoint and goal.finish all read the same
 * inventory so the runtime never advertises an ID it will later reject. Drift
 * between these layers is what makes completion fail with a citation the model
 * was explicitly told to use.
 */

/** Successful output of these tools is coordination, never proof of completion. */
export const NON_PROOF_TOOLS = new Set([
  'agent.adapt',
  'context.read',
  'goal.finish',
  'human.ask',
  'mode.switch',
  'plan.execute',
  'plan.propose',
  'skill.load',
  'subagent.delegate',
  'task.create',
  'task.get',
  'task.list',
  'task.update',
  'tools.invalid',
  'work.checkpoint',
]);

export function isSuccessfulProofCall(call: ToolCallRecord): boolean {
  const out = call.outputRef as { error?: unknown; exitCode?: number; verification?: { status: string } } | null;
  return ['completed', 'compacted'].includes(call.status) && !call.error && out !== null && !out.error
    && (!Object.hasOwn(out, 'exitCode') || out.exitCode === 0)
    && (!out.verification || out.verification.status === 'success') && !NON_PROOF_TOOLS.has(call.toolId);
}

export interface PlanExecutionBoundary {
  executionId?: string;
  approvedRunId?: string;
  approvedStepIndex?: number;
}

/** Proof must postdate the approval of the plan it is cited for. */
export function belongsToPlanExecution(call: ToolCallRecord, plan: PlanExecutionBoundary | undefined): boolean {
  if (!plan?.executionId || !call.runId || !call.stepId) return false;
  const run = store.getRun(call.runId);
  if (run.metadata.goalExecutionId !== plan.executionId) return false;
  return call.runId !== plan.approvedRunId ||
    store.getRunStep(call.stepId).index > (plan.approvedStepIndex ?? Number.MAX_SAFE_INTEGER);
}

export function isGoalProof(call: ToolCallRecord, plan: PlanExecutionBoundary | undefined): boolean {
  return belongsToPlanExecution(call, plan) && isSuccessfulProofCall(call);
}

export function planBoundaryOf(session: { sessionMetadata?: Record<string, unknown> | null } | null | undefined): PlanExecutionBoundary | undefined {
  return session?.sessionMetadata?.plan as PlanExecutionBoundary | undefined;
}

/** Calls whose owning work is `work` itself or one of its descendants. */
export function workOwnedCalls(work: WorkRecord): ToolCallRecord[] {
  return store.listSessionTree(work.sessionId).flatMap(s => store.listToolCalls(s.id)).filter(call => {
    if (!call.runId) return false;
    const id = (call.stepId ? store.getRunStep(call.stepId).metadata.workId : undefined) ?? store.getRun(call.runId).metadata.workId;
    if (id === work.id) return true;
    let child = typeof id === 'string' ? workStore.get(id) : null;
    const seen = new Set<string>();
    while (child?.parentWorkId && !seen.has(child.id)) {
      if (child.parentWorkId === work.id) return true;
      seen.add(child.id); child = workStore.get(child.parentWorkId);
    }
    return false;
  });
}

/** Every work that owns a call inside this work's tree, this work first. */
export function workOwners(work: WorkRecord, calls = workOwnedCalls(work)): WorkRecord[] {
  const ids = new Set<string>([work.id]);
  for (const call of calls) {
    const id = call.stepId
      ? store.getRunStep(call.stepId).metadata.workId ?? (call.runId ? store.getRun(call.runId).metadata.workId : null)
      : null;
    if (typeof id === 'string') ids.add(id);
  }
  return [work, ...[...ids].filter(id => id !== work.id)
    .map(id => workStore.get(id))
    .filter((owner): owner is WorkRecord => owner !== null)];
}

/** Works currently active in a session tree: enough to classify receipts without scanning calls. */
export function treeWorks(sessionId: string): WorkRecord[] {
  return store.listSessionTree(sessionId)
    .map(session => workStore.current(session.id))
    .filter((work): work is WorkRecord => work !== null);
}

export interface EvidenceInventory {
  proof: ToolCallRecord[];
  proofIds: Set<string>;
  owners: WorkRecord[];
  /** Receipts whose change version no longer matches their work (cheap, no I/O). */
  supersededReceiptIds: Set<string>;
}

/** Cheap synchronous inventory: what completion can accept without fingerprinting. */
export function evidenceInventory(work: WorkRecord, calls = workOwnedCalls(work), plan?: PlanExecutionBoundary): EvidenceInventory {
  const owners = workOwners(work, calls);
  const bounded = plan?.executionId ? calls.filter(call => belongsToPlanExecution(call, plan)) : calls;
  const proof = bounded.filter(isSuccessfulProofCall);
  return {
    proof,
    proofIds: new Set(proof.map(call => call.id)),
    owners,
    supersededReceiptIds: new Set(supersededReceipts(owners).keys()),
  };
}

/** Successful receipts that a later change version already replaced. */
export function supersededReceipts(owners: WorkRecord[]): Map<string, VerificationRecord> {
  const superseded = new Map<string, VerificationRecord>();
  for (const owner of owners)
    for (const record of owner.verifications)
      if (record.status === 'success' && record.changeVersion !== owner.changeVersion) superseded.set(record.toolCallId, record);
  return superseded;
}

export interface ReceiptReport {
  /** Receipts confirmed against the current change version and workspace fingerprint. */
  current: Set<string>;
  /** `criterion` → the confirmed current receipt for that criterion. */
  currentByCriterion: Map<string, string>;
  /** Successful receipts that no longer attest the current version, with why. */
  superseded: Map<string, { criterion: string; reason: string }>;
  /** Receipts that never succeeded. */
  unsuccessful: Map<string, { criterion: string; status: string }>;
  /** All receipts known to these works, whatever their status. */
  known: Set<string>;
}

/**
 * Authoritative receipt check for acceptance: a receipt counts only when it
 * still describes the current change version *and* the workspace it verified.
 */
export async function receiptReport(owners: WorkRecord[], runId?: string | null): Promise<ReceiptReport> {
  const report: ReceiptReport = {
    current: new Set(), currentByCriterion: new Map(), superseded: new Map(), unsuccessful: new Map(), known: new Set(),
  };
  for (const owner of owners) {
    for (const record of owner.verifications) {
      report.known.add(record.toolCallId);
      if (record.status !== 'success') {
        report.unsuccessful.set(record.toolCallId, { criterion: record.criterion, status: record.status });
        continue;
      }
      if (record.changeVersion !== owner.changeVersion) {
        report.superseded.set(record.toolCallId, {
          criterion: record.criterion,
          reason: `it verified change version ${record.changeVersion}, now ${owner.changeVersion}`,
        });
        continue;
      }
      if (record.external && record.runId !== runId) {
        report.superseded.set(record.toolCallId, { criterion: record.criterion, reason: 'an external receipt from another run cannot attest this run' });
        continue;
      }
      if (record.fingerprint !== await workspaceFingerprint(owner.sessionId, record.scope)) {
        report.superseded.set(record.toolCallId, {
          criterion: record.criterion,
          reason: 'the verified scope changed after the check',
        });
        continue;
      }
      report.current.add(record.toolCallId);
      if (!report.currentByCriterion.has(record.criterion)) report.currentByCriterion.set(record.criterion, record.toolCallId);
    }
  }
  return report;
}

export interface NormalizedEvidence {
  items: Array<{ criterion: string; summary: string; toolCallIds?: string[]; artifactIds?: string[] }>;
  /** Cited receipts that were repaired by pointing at the current receipt for the same criterion. */
  repaired: Array<{ cited: string; criterion: string; replacement: string }>;
  /** Cited proof IDs that no longer attest anything now, with the remedy for each. */
  stale: Array<{ id: string; criterion: string; reason: string }>;
  /** Cited IDs with no successful proof behind them at all. */
  unknown: string[];
}

/**
 * Acceptance mirrors intent, not bookkeeping: when a criterion was re-verified
 * after the cited receipt, the citation is repointed at the current receipt
 * instead of failing the round. Everything that cannot be repaired is reported
 * with the exact ids that would be accepted.
 */
export function normalizeEvidence(
  evidence: Array<{ criterion: string; summary: string; toolCallIds?: string[]; artifactIds?: string[] }>,
  report: ReceiptReport,
  proofIds: Set<string>,
): NormalizedEvidence {
  const normalized: NormalizedEvidence = { items: [], repaired: [], stale: [], unknown: [] };
  for (const item of evidence) {
    const kept: string[] = [];
    for (const id of item.toolCallIds ?? []) {
      if (proofIds.has(id) && !report.superseded.has(id)) {
        if (!kept.includes(id)) kept.push(id);
        continue;
      }
      const misplaced = report.superseded.get(id);
      if (misplaced) {
        const replacement = report.currentByCriterion.get(item.criterion);
        if (replacement && proofIds.has(replacement)) {
          normalized.repaired.push({ cited: id, criterion: item.criterion, replacement });
          if (!kept.includes(replacement)) kept.push(replacement);
          continue;
        }
        normalized.stale.push({ id, criterion: misplaced.criterion, reason: misplaced.reason });
        if (!kept.includes(id)) kept.push(id);
        continue;
      }
      const failed = report.unsuccessful.get(id);
      if (failed) {
        normalized.stale.push({ id, criterion: failed.criterion, reason: `the check ${failed.status}` });
        if (!kept.includes(id)) kept.push(id);
        continue;
      }
      // Not proof of anything: foreign, unsuccessful or excluded.
      if (!proofIds.has(id) && !report.known.has(id) && !normalized.unknown.includes(id)) normalized.unknown.push(id);
      if (!kept.includes(id)) kept.push(id);
    }
    normalized.items.push({ ...item, ...(item.toolCallIds ? { toolCallIds: kept } : {}) });
  }
  return normalized;
}

/** Human-readable, state-derived remedy: identical attempts produce identical text. */
export function evidenceRemedy(report: ReceiptReport, criterion?: string): string {
  const ids = criterion
    ? [report.currentByCriterion.get(criterion)].filter((id): id is string => typeof id === 'string')
    : [...report.current];
  return `Rerun verification.run for the changed scope${criterion ? ` (criterion: ${criterion})` : ''} and cite its receipt id` +
    `${ids.length ? `; current receipts: ${ids.join(', ')}` : '; no receipt currently attests the workspace version'}.`;
}
