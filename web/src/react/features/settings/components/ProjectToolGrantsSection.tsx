import { useCallback, useEffect, useState } from "react";
import { Button } from "@heroui/react";
import { ShieldCheck } from "lucide-react";
import {
  agentRuntimeApi,
  type ProjectToolGrant,
} from "../../../../lib/api/agentRuntime";
import { useLocale } from "../../../../hooks/useLocale";
import { SettingsCard } from "./SettingsCard";

export function ProjectToolGrantsSection({ projectId }: { projectId: string }) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const [items, setItems] = useState<ProjectToolGrant[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const load = useCallback(async () => {
    try {
      setItems((await agentRuntimeApi.listProjectToolGrants(projectId)).items);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }, [projectId]);
  useEffect(() => { void load(); }, [load]);

  async function revoke(toolId: string) {
    setBusy(toolId);
    try {
      await agentRuntimeApi.revokeProjectToolGrant(projectId, toolId);
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  }

  return (
    <SettingsCard
      title={zh ? "始终允许的工具" : "Always-allowed tools"}
      description={zh ? "仅对本项目有效；撤销不会停止已经启动的操作。" : "Only for this project. Revoking does not stop running operations."}
      icon={ShieldCheck}
    >
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      {items.some((item) => item.toolId === "bash") && (
        <p className="text-sm text-warning">
          {zh ? "已允许 bash：本项目后续的任意 Shell 命令都无需审批。" :
            "bash is approved: any future Shell command in this project can run without approval."}
        </p>
      )}
      {items.length === 0 ? (
        <p className="settings-note">{zh ? "暂无项目级工具授权。" : "No project-wide tool approvals."}</p>
      ) : (
        <ul className="space-y-2">
          {items.map((grant) => (
            <li key={grant.toolId} className="flex items-center justify-between gap-3">
              <span className="text-sm font-mono">{grant.toolId}</span>
              <Button size="sm" variant="danger-soft" isDisabled={busy !== null}
                onPress={() => void revoke(grant.toolId)}
                aria-label={`${zh ? "撤销" : "Revoke"} ${grant.toolId}`}>
                {zh ? "撤销" : "Revoke"}
              </Button>
            </li>
          ))}
        </ul>
      )}
    </SettingsCard>
  );
}
