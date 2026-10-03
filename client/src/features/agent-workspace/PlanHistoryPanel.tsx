import { useState } from "react";
import { RotateCcw, History, Loader2 } from "lucide-react";
import {
  agentRuntimeApi,
  type AgentPlanArtifact,
  type AgentSession,
} from "../../adapters/transport/agentRuntime";
import { useAgentSessionStore } from "./state/agentSessionStore";
import { useLocale } from "../../shared/hooks/useLocale";

function PlanReport({ plan, zh }: { plan: AgentPlanArtifact; zh: boolean }) {
  return (
    <div className="space-y-2 rounded-md border border-border/60 bg-background/35 p-2 text-[11px]">
      <div className="font-medium text-foreground">{plan.title}</div>
      <p className="whitespace-pre-wrap text-foreground/80">{plan.objective}</p>
      {plan.steps.length > 0 && (
        <ol className="list-decimal space-y-1 ps-5 text-foreground/75">
          {plan.steps.slice(0, 12).map((step) => (
            <li key={step.id}>
              {step.title}
              {step.description ? ` — ${step.description}` : ""}
            </li>
          ))}
        </ol>
      )}
      {plan.acceptanceCriteria.length > 0 && (
        <div>
          <strong className="font-medium">
            {zh ? "验收标准" : "Acceptance criteria"}
          </strong>
          <ul className="list-disc space-y-1 ps-5 text-foreground/75">
            {plan.acceptanceCriteria.slice(0, 12).map((criterion) => (
              <li key={criterion}>{criterion}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function PlanHistoryPanel({
  session,
  currentRevision,
}: {
  session: AgentSession;
  currentRevision: number;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const refreshSessions = useAgentSessionStore((state) => state.refreshSessions);
  const [plans, setPlans] = useState<AgentPlanArtifact[] | null>(null);
  const [selectedRevision, setSelectedRevision] = useState(currentRevision);
  const [loading, setLoading] = useState(false);
  const [restoring, setRestoring] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPlans = async () => {
    if (plans || loading) return;
    setLoading(true);
    setError(null);
    try {
      const result = await agentRuntimeApi.listSessionPlans(session.id);
      setPlans(result.plans);
      if (result.plans.length && !result.plans.some((item) => item.revision === selectedRevision))
        setSelectedRevision(result.plans[0].revision);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoading(false);
    }
  };

  const selected = plans?.find((item) => item.revision === selectedRevision) ?? null;
  const toggleHistory = () => {
    if (!plans) void loadPlans();
  };
  const restore = async () => {
    if (!selected || selected.revision === currentRevision || restoring) return;
    setRestoring(true);
    setError(null);
    try {
      const result = await agentRuntimeApi.restoreSessionPlanRevision(
        session.id,
        selected.revision,
      );
      await refreshSessions({ joinPending: true });
      setPlans((items) =>
        items ? [result.plan, ...items.filter((item) => item.id !== result.plan.id)] : items,
      );
      setSelectedRevision(result.plan.revision);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRestoring(false);
    }
  };

  return (
    <div className="mt-2 border-t border-border/50 pt-2">
      <button
        type="button"
        className="inline-flex items-center gap-1.5 text-[10px] text-muted-foreground hover:text-foreground"
        onClick={toggleHistory}
        aria-expanded={Boolean(plans)}
      >
        <History size={12} aria-hidden />
        {zh ? "查看计划版本" : "View plan versions"}
      </button>
      {loading && (
        <div className="mt-2 flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <Loader2 size={12} className="animate-spin" aria-hidden />
          {zh ? "加载版本…" : "Loading versions…"}
        </div>
      )}
      {error && <p className="mt-2 text-[10px] text-danger">{error}</p>}
      {plans && !loading && (
        <div className="mt-2 space-y-2">
          <div className="flex flex-wrap gap-1.5" role="list" aria-label={zh ? "计划版本" : "Plan versions"}>
            {plans.map((plan) => (
              <button
                key={plan.id}
                type="button"
                role="listitem"
                aria-pressed={selectedRevision === plan.revision}
                className={`rounded border px-1.5 py-0.5 text-[10px] ${selectedRevision === plan.revision ? "border-primary/70 bg-primary/10 text-foreground" : "border-border/60 text-muted-foreground hover:text-foreground"}`}
                onClick={() => setSelectedRevision(plan.revision)}
              >
                v{plan.revision} · {plan.status}
              </button>
            ))}
          </div>
          {selected && (
            <>
              <PlanReport plan={selected} zh={zh} />
              {selected.revision !== currentRevision && (
                <button
                  type="button"
                  className="inline-flex items-center gap-1.5 rounded border border-border/70 px-2 py-1 text-[10px] text-foreground hover:bg-foreground/5 disabled:opacity-50"
                  onClick={() => void restore()}
                  disabled={restoring}
                >
                  {restoring ? <Loader2 size={11} className="animate-spin" aria-hidden /> : <RotateCcw size={11} aria-hidden />}
                  {zh ? "恢复为新草稿" : "Restore as new draft"}
                </button>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
