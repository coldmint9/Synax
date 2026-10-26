import type { AgentProfile } from '../contracts.js';

export const CONVERSATION_MERGE_WORKER_PROFILE_ID = 'git-merge-worker';
export const CONVERSATION_MERGE_WORKER_PROVIDER_ID = 'conversation-git-worker';

// Keep the profile independent of the worker runtime: HTTP hosts must resolve
// persisted child sessions even when execution only happened in another process.
export const conversationMergeWorkerProfile: AgentProfile = {
  id: CONVERSATION_MERGE_WORKER_PROFILE_ID,
  label: 'Git merge worker',
  kind: 'executor',
  mode: 'subagent',
  description: 'Internal worker that performs one bound Git merge and reports summaries to its parent.',
  defaultThinkingMode: 'deep',
  allowedCapabilities: [
    'git.merge.worker.inspect', 'git.merge.worker.prepare', 'git.merge.worker.files',
    'git.merge.worker.read', 'git.merge.worker.resolve', 'git.merge.worker.continue',
    'git.merge.worker.checks', 'git.merge.worker.finalize', 'git.merge.worker.waiting',
    'git.merge.worker.report', 'git.merge.worker.recover',
  ],
  permissionDefaults: [
    { gate: 'read', pattern: '*', action: 'allow', reason: 'Read the bound isolated merge task.' },
    { gate: 'write', pattern: '*', action: 'allow', reason: 'Write only through merge worker tools.' },
    { gate: 'task', pattern: '*', action: 'deny', reason: 'A merge worker cannot create or delegate tasks.' },
    { gate: 'none', pattern: '*', action: 'allow', reason: 'Internal commands validate their durable worker binding.' },
  ],
  maxSteps: 48,
  status: 'active',
  allowsSubsessions: false,
  toolProviderId: CONVERSATION_MERGE_WORKER_PROVIDER_ID,
  toolPolicy: { allowParallelReadTools: true, allowSubtasks: false, maxParallelReadTools: 2 },
  loopHints: [
    'Use only git.merge.worker.* tools.',
    'Inspect, prepare, resolve every conflict from all three sides, continue, run configured checks, and finalize. Never skip checks.',
    'For failed/interrupted/preparing/checking/applying states after interruption, call git.merge.worker.recover once, inspect the reconciled state and continue. If the target/source changed, report waiting instead of retrying unchanged writes.',
    'Re-enter the same task from its durable state. Prepare only drafts, reuse staged resolutions and finish the next incomplete step. Repeated completed steps return current progress. A stopped or superseded execution must not bypass its fence: report the objectId so the parent can call git.merge.resume.',
    'Honor the current parent instructions, including explicit conflict decisions. For modify/delete conflicts use resolve(choice=source/target/delete); choosing a missing side accepts its deletion. Never recreate a deleted file with empty content.',
    'Report concise milestone summaries. Call git.merge.worker.report(joinMode=async) when the parent may continue independent work.',
    'Call git.merge.worker.waiting when a safe decision is impossible or verification is unavailable; then finish this worker turn.',
  ],
};
