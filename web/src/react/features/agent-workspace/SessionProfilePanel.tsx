import { memo } from "react";
import type { AgentRun, AgentRunStep } from "../../../lib/api/agentRuntime";
import { Skeleton } from "@heroui/react";
import { SlidersHorizontal } from "lucide-react";
import { useShallow } from "zustand/react/shallow";
import { useLocale } from "../../../hooks/useLocale";
import { useAgentSessionStore } from "./state/agentSessionStore";
import { SessionCapabilitiesPanel } from "./SessionCapabilitiesPanel";
import { SessionRuntimeStatus, SessionStatusCard } from "./SessionWorkspace";
import { SessionSystemPromptPanel } from "./SessionSystemPromptPanel";
import { WorkspaceSection } from "./WorkspaceSection";

const EMPTY_STEPS: AgentRunStep[] = [];
const EMPTY_RUNS: AgentRun[] = [];

export const SessionProfilePanel = memo(function SessionProfilePanel({
  sessionId,
}: {
  sessionId: string | null;
}) {
  const { locale } = useLocale();
  const { loading, sessionStats, sessionCapabilities, steps, runs, session } =
    useAgentSessionStore(
      useShallow((s) => ({
        loading: s.detailLoading,
        sessionStats: s.selectedSessionId === sessionId ? s.sessionStats : null,
        sessionCapabilities:
          s.selectedSessionId === sessionId ? s.sessionCapabilities : null,
        steps: s.selectedSessionId === sessionId ? s.steps : EMPTY_STEPS,
        runs: s.selectedSessionId === sessionId ? s.runs : EMPTY_RUNS,
        session: s.sessions.find((item) => item.id === sessionId),
      })),
    );
  if (!sessionId) return null;
  return (
    <div className="work-runtime-details">
      <WorkspaceSection
        key={sessionId}
        storageKey={`${sessionId}:runtime`}
        icon={<SlidersHorizontal size={13} />}
        title={locale === "zh" ? "运行详情" : "Runtime details"}
        hideTitle
        defaultOpen={false}
        actions={
          <span className="runtime-header-metrics">
            <SessionRuntimeStatus
              stats={sessionStats}
              session={session}
              steps={steps}
            />
          </span>
        }
      >
        {loading && !sessionStats ? (
          <Skeleton className="m-3 h-12 rounded-lg" />
        ) : (
          <>
            {sessionStats && (
              <SessionStatusCard
                showRuntimeStatus={false}
                stats={sessionStats}
                session={session}
                runs={runs}
                steps={steps}
              />
            )}
            {sessionCapabilities && (
              <SessionCapabilitiesPanel capabilities={sessionCapabilities} />
            )}
            {session && <SessionSystemPromptPanel session={session} />}
            {!sessionStats && !sessionCapabilities && (
              <p className="ws-empty">
                {locale === "zh" ? "暂无运行数据" : "No runtime data yet"}
              </p>
            )}
          </>
        )}
      </WorkspaceSection>
    </div>
  );
});
