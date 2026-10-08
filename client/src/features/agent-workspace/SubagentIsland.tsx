import { BotMessageSquare, X } from "lucide-react";
import type { SessionEnvironmentSubagent } from "../../adapters/transport/agentRuntime";
import { IslandSurface } from "../../app/layouts/IslandSurface";
import { Popover, PopoverButton, PopoverPanel } from "@/shared/ui/ui/Popover";
import { useLocale } from "../../shared/hooks/useLocale";
import type { I18nKey } from "../../shared/lib/i18n";
import { useSessionWorkspaceEnvironment } from "./SessionEnvironmentContext";
import { getSubagentNameFromId } from "./SubagentIdentity";
import { openWorkspaceSubagent, useSessionWorkspace } from "./state/sessionWorkspaceStore";
import "./subagentIsland.css";

const STATUS_KEYS: Record<string, I18nKey> = {
  queued: "workspaceStatusQueued",
  running: "workspaceStatusRunning",
  waiting_permission: "workspaceStatusWaitingPermission",
  waiting_input: "workspaceStatusWaitingInput",
  completed: "workspaceStatusCompleted",
  failed: "workspaceStatusFailed",
  cancelled: "workspaceStatusCancelled",
  interrupted: "workspaceStatusInterrupted",
  paused: "workspaceStatusPaused",
};
const PRIORITY: Record<string, number> = {
  failed: 0, interrupted: 0, waiting_permission: 1, waiting_input: 1,
  running: 2, queued: 3, paused: 4, completed: 5, cancelled: 5,
};

function taskSummary(subagent: SessionEnvironmentSubagent): string {
  return subagent.title?.trim() || subagent.prompt.trim().split("\n")[0]?.replace(/^#+\s*/, "") || "Subagent";
}

export function SubagentIsland({ sessionId }: { sessionId: string }) {
  const { environment } = useSessionWorkspaceEnvironment(sessionId);
  const { subagent } = useSessionWorkspace(sessionId);
  const { locale, t } = useLocale();
  const zh = locale === "zh";
  const children = environment?.subagents ?? [];
  if (!children.length) return null;
  const running = children.filter((child) => child.status === "running").length;
  const label = zh ? `子代理，${running} 个工作中` : `Subagents, ${running} working`;
  const sorted = [...children].sort((a, b) => (PRIORITY[a.status] ?? 4) - (PRIORITY[b.status] ?? 4));

  return (
    <div className="subagent-island-anchor">
      <Popover key={sessionId}>
        {({ close }) => (
          <>
            <IslandSurface>
              <PopoverButton className="subagent-island-trigger" aria-label={label} title={label}>
                <BotMessageSquare size={17} aria-hidden="true" />
                {running > 0 && <span className="subagent-island-dot" aria-hidden="true" />}
                <span className="subagent-island-count" aria-hidden="true">{running}</span>
              </PopoverButton>
            </IslandSurface>
            <PopoverPanel anchor={{ to: "bottom", gap: 8, padding: 12 }} focus className="subagent-island-list" aria-label={zh ? "当前主对话的子代理" : "Subagents of this conversation"}>
              <div className="subagent-island-list-header">
                <div>
                  <strong>{t("workspaceCardSubagents")}</strong>
                  <p>{zh ? `当前主对话 · ${running} 个工作中` : `Current conversation · ${running} working`}</p>
                </div>
                <button type="button" className="subagent-island-close" onClick={() => close()} aria-label={zh ? "关闭子代理列表" : "Close subagent list"}><X size={15} /></button>
              </div>
              <div className="subagent-island-rows">
                {sorted.map((child) => (
                  <button key={child.id} type="button" className="subagent-island-row" aria-current={subagent?.sessionId === child.id ? "true" : undefined} onClick={() => {
                    openWorkspaceSubagent(sessionId, child.id, getSubagentNameFromId(child.id, child.subagentName));
                    close();
                  }}>
                    <span className="subagent-island-avatar" aria-hidden="true"><BotMessageSquare size={18} /></span>
                    <span className="subagent-island-row-copy">
                      <span className="subagent-island-row-heading"><strong>{getSubagentNameFromId(child.id, child.subagentName)}</strong><span className="subagent-island-status" data-status={child.status}>{STATUS_KEYS[child.status] ? t(STATUS_KEYS[child.status]) : child.status}</span></span>
                      <span className="subagent-island-task">{child.roleName ? `${child.roleName} · ` : ""}{taskSummary(child)}</span>
                    </span>
                  </button>
                ))}
              </div>
              <p className="subagent-island-list-footer">{zh ? "选择一项，在右侧查看完整对话" : "Select a subagent to view its conversation alongside"}</p>
            </PopoverPanel>
          </>
        )}
      </Popover>
    </div>
  );
}
