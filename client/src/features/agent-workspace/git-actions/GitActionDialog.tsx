import { useEffect, useState } from "react";
import {
  GitCommitHorizontal,
  GitPullRequest,
  LoaderCircle,
} from "lucide-react";
import {
  Dialog,
  DialogContainer,
  DialogPanel,
  DialogHeader,
  DialogTitle,
  DialogCloseButton,
  DialogBody,
} from "../../../shared/ui/ui/Dialog";
import { Select } from "../../../shared/ui/ui/Select";
import {
  agentRuntimeApi,
  type AgentSession,
  type SessionEnvironmentRoot,
} from "../../../adapters/transport/agentRuntime";
import LocalGitPanel from "./LocalGitPanel";
import RemotePrPanel from "./RemotePrPanel";
export default function GitActionDialog({
  intent,
  session,
  onClose,
  onTaskReady,
}: {
  intent: "commit" | "pr";
  session: AgentSession;
  onClose: () => void;
  onTaskReady: () => void;
}) {
  const [roots, setRoots] = useState<SessionEnvironmentRoot[]>([]);
  const [rootId, setRootId] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    let current = true;
    void agentRuntimeApi
      .getSessionEnvironmentRoots(session.id)
      .then((result) => {
        if (current) {
          const available = result.repositories.filter(
            (root) => root.status === "ready",
          );
          setRoots(available);
          if (available.length === 1) setRootId(available[0].rootId);
        }
      })
      .catch((e) => {
        if (current) setError(e.message);
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => {
      current = false;
    };
  }, [session.id]);
  return (
    <Dialog open onClose={onClose} dismissible={!busy}>
      <DialogContainer size="md">
        <DialogPanel className="git-action-dialog">
          <DialogHeader>
            {intent === "commit" ? (
              <GitCommitHorizontal size={19} />
            ) : (
              <GitPullRequest size={19} />
            )}
            <DialogTitle>
              {intent === "commit"
                ? "Commit · 本地工作区"
                : "PR · 远程合并与同步"}
            </DialogTitle>
          </DialogHeader>
          <DialogCloseButton disabled={busy} aria-label="关闭 Git 面板" />
          <DialogBody>
            <p className="git-actions-description">
              {intent === "commit"
                ? "提交当前改动、切换分支，或在对话中分析本地合并。"
                : "连接已配置的 GitHub / GitLab remote，将远程请求带入当前对话。"}
            </p>
            {loading ? (
              <div className="git-actions-loading">
                <LoaderCircle size={16} className="git-actions-spin" />
                正在读取仓库…
              </div>
            ) : (
              <>
                {error && (
                  <p role="alert" className="git-actions-error">
                    {error}
                  </p>
                )}
                {roots.length > 1 && (
                  <Select
                    label="选择仓库"
                    value={rootId}
                    onChange={setRootId}
                    disabled={busy}
                    options={roots.map((root) => ({
                      value: root.rootId,
                      label: root.name,
                    }))}
                  />
                )}{" "}
                {!roots.length && !error && (
                  <p>当前会话没有可用仓库，请先选择本地 Git 工作区。</p>
                )}
                {rootId &&
                  (intent === "commit" ? (
                    <LocalGitPanel
                      key={rootId}
                      session={session}
                      rootId={rootId}
                      onBusy={setBusy}
                      onTaskReady={onTaskReady}
                    />
                  ) : (
                    <RemotePrPanel
                      key={rootId}
                      sessionId={session.id}
                      rootId={rootId}
                      onBusy={setBusy}
                      onTaskReady={onTaskReady}
                    />
                  ))}
              </>
            )}
          </DialogBody>
        </DialogPanel>
      </DialogContainer>
    </Dialog>
  );
}
