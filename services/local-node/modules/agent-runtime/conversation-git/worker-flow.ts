import type { ConversationGitSnapshot, ConversationGitActionName } from './contracts.js';
import type { GitMrService } from '../../git-mr/service.js';

export interface MergeWorkerFlow {
  snapshot(): Promise<ConversationGitSnapshot>;
  action(action: ConversationGitActionName, snapshot: ConversationGitSnapshot): Promise<void>;
  packet(snapshot: ConversationGitSnapshot): ReturnType<GitMrService['conflictPacket']>;
  diagnostics(snapshot: ConversationGitSnapshot): ReturnType<GitMrService['repairContext']>;
  waiting(reason: string, snapshot: ConversationGitSnapshot): Promise<void>;
}

/** Advance deterministic Git transitions until a model decision is necessary. */
export async function advanceMergeWorker(flow: MergeWorkerFlow) {
  let recovered = false;
  const visited = new Set<string>();
  for (;;) {
    const snapshot = await flow.snapshot();
    const { mr, execution } = snapshot;
    const state = { objectId: snapshot.task.id, status: mr.status, candidateOid: mr.candidateOid };
    if (['merged', 'noop', 'cancelled'].includes(mr.status)) return { ...state, decision: 'done' as const };
    if (!execution || !['queued', 'running'].includes(execution.status))
      return { ...state, decision: 'waiting' as const, reason: execution?.summary ?? 'The merge worker is stopped.' };
    // Version counters alone are not progress: reentrant calls can create new
    // receipts without changing the merge, its candidate or its check results.
    const fingerprint = JSON.stringify([mr.status, mr.currentStep, mr.candidateOid,
      mr.steps.map(step => step.status), mr.checkResults.map(check => [check.id, check.status, check.tree])]);
    if (visited.has(fingerprint)) {
      const reason = 'Git state did not advance. Inspect the retained candidate before continuing.';
      await flow.waiting(reason, snapshot);
      return { ...state, decision: 'waiting' as const, reason };
    }
    visited.add(fingerprint);
    if (mr.status === 'draft') { await flow.action('prepare', snapshot); continue; }
    if (mr.status === 'conflicted') {
      const packet = await flow.packet(snapshot);
      if (packet.totalFiles) return { ...state, decision: 'conflicts' as const, packet };
      await flow.action('continue', snapshot); continue;
    }
    if (mr.status === 'check_failed') {
      const diagnostics = await flow.diagnostics(snapshot);
      if (diagnostics.files.length && diagnostics.remainingAttempts > 0)
        return { ...state, decision: 'repair' as const, diagnostics };
      const reason = diagnostics.remainingAttempts === 0
        ? 'Verification still fails after three candidate repair rounds. Review the remaining diagnostics.'
        : 'Failed checks did not identify a supported tracked file. Review the diagnostics before continuing.';
      await flow.waiting(reason, snapshot);
      return { ...state, decision: 'waiting' as const, reason, diagnostics };
    }
    if (mr.status === 'ready') {
      if (!mr.checks.length) {
        const reason = 'No verification commands configured. Configure checks before applying this candidate.';
        await flow.waiting(reason, snapshot);
        return { ...state, decision: 'waiting' as const, reason };
      }
      const verified = Boolean(mr.candidateTree) && mr.checks.every(check => mr.checkResults.some(result =>
        result.id === check.id && result.status === 'passed' && result.tree === mr.candidateTree));
      await flow.action(verified ? 'finalize' : 'checks', snapshot); continue;
    }
    if (!recovered && ['failed', 'interrupted', 'preparing', 'checking', 'applying'].includes(mr.status)) {
      recovered = true; await flow.action('resume', snapshot); continue;
    }
    const reason = `Merge state ${mr.status} requires inspection; automatic recovery did not reach a decision point.`;
    await flow.waiting(reason, snapshot);
    return { ...state, decision: 'waiting' as const, reason };
  }
}
