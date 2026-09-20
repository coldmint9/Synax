import type {
  AgentRun,
  AgentRunStep,
  AgentSession,
  ReasoningEffort,
} from "../../../lib/api/agentRuntime";

function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

/** Read execution records only; composer drafts must never influence this display. */
export function sessionRuntimeSelection(
  session: AgentSession | undefined,
  runs: AgentRun[],
  steps: AgentRunStep[],
) {
  const latest = <T extends { startedAt: string }>(items: T[]) =>
    items.reduce<T | undefined>(
      (current, item) =>
        !current || item.startedAt >= current.startedAt ? item : current,
      undefined,
    );
  const run =
    session &&
    (runs.find(
      (item) =>
        item.sessionId === session.id && item.id === session.activeRunId,
    ) ??
      latest(runs.filter((item) => item.sessionId === session.id)));
  const step =
    session &&
    latest(
      steps.filter(
        (item) =>
          item.sessionId === session.id && (!run || item.runId === run.id),
      ),
    );
  const native = session?.sessionMetadata?.nativeBackend as
    | { model?: string }
    | undefined;
  const binding = session?.sessionMetadata?.backend as
    | { model?: string }
    | undefined;
  const effortRecord =
    step?.metadata && "reasoningEffort" in step.metadata
      ? step.metadata
      : run?.metadata && "reasoningEffort" in run.metadata
        ? run.metadata
        : undefined;
  const effort = effortRecord
    ? effortRecord.reasoningEffort
    : session?.reasoningEffort;
  return {
    model:
      text(step?.model) ??
      text(run?.model) ??
      text(session?.model) ??
      text(native?.model) ??
      text(binding?.model),
    reasoningEffort:
      typeof effort === "string" &&
      ["low", "medium", "high", "xhigh", "max"].includes(effort)
        ? (effort as ReasoningEffort)
        : null,
  };
}
