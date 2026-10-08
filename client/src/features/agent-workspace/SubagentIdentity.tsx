import { Bot } from "lucide-react";
import type { AgentSession } from "../../adapters/transport/agentRuntime";

const FALLBACK_ROLES: Record<string, { name: string; description: string }> = {
  explorer: { name: "探索员", description: "读取代码、搜索线索并梳理系统结构。" },
  reviewer: { name: "审查员", description: "检查实现、发现风险并给出可执行的审查意见。" },
};

export function getSubagentNameFromId(
  id: string,
  persistedName?: string | null,
): string {
  if (typeof persistedName === "string" && persistedName.trim()) {
    return persistedName.trim();
  }
  return `子代理 ${id.slice(0, 8)}`;
}

export function getSubagentName(session: AgentSession): string {
  return getSubagentNameFromId(session.id, session.sessionMetadata?.subagentName);
}

export function getSubagentRole(session: AgentSession) {
  const metadata = session.sessionMetadata;
  const fallback = FALLBACK_ROLES[session.profileId] ?? {
    name: "研究员",
    description: "根据委派任务进行分析和整理。",
  };
  return {
    name:
      typeof metadata?.roleName === "string" && metadata.roleName.trim()
        ? metadata.roleName.trim()
        : fallback.name,
    description:
      typeof metadata?.roleDescription === "string" && metadata.roleDescription.trim()
        ? metadata.roleDescription.trim()
        : fallback.description,
  };
}

interface Props {
  session: AgentSession;
  compact?: boolean;
  showStatus?: boolean;
}

export function SubagentIdentity({
  session,
  compact = false,
  showStatus = true,
}: Props) {
  const name = getSubagentName(session);
  const role = getSubagentRole(session);
  return (
    <div className={`subagent-identity${compact ? " subagent-identity--compact" : ""}`}>
      <span className="subagent-avatar" aria-hidden="true">
        <Bot size={compact ? 14 : 17} strokeWidth={2.1} />
      </span>
      <span className="subagent-identity-copy">
        <span className="subagent-identity-name">{name}</span>
        <span className="subagent-identity-role">{role.name}</span>
      </span>
      {showStatus ? (
        <span className="subagent-status-dot" data-status={session.status} aria-label={session.status} />
      ) : null}
    </div>
  );
}

export function SubagentProfileCard({
  session,
  showIdentity = true,
}: {
  session: AgentSession;
  showIdentity?: boolean;
}) {
  const role = getSubagentRole(session);
  return (
    <div className="subagent-profile-card">
      {showIdentity ? <SubagentIdentity session={session} showStatus={false} /> : null}
      <div className="subagent-profile-copy">
        {!showIdentity ? null : <div className="subagent-profile-role">{role.name}</div>}
        <p className="subagent-profile-description">{role.description}</p>
      </div>
    </div>
  );
}
