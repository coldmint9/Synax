import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  GitCommitHorizontal,
  GitPullRequest,
  Upload,
  LoaderCircle,
} from "lucide-react";
import { Button } from "../../../shared/ui/ui/Button";
import type {
  AgentSession,
  WorkspaceRepositoryGit,
} from "../../../adapters/transport/agentRuntime";
import { useWorkspaceGit } from "../workspaceGitStore";
import { SessionCommitDialog } from "../SessionCommitDialog";
import { SessionPushDialog } from "../SessionPushDialog";
import "./gitActions.css";
const GitActionDialog = lazy(() => import("./GitActionDialog"));
export default function ComposerGitActions({
  session,
  projectId,
  disabled = false,
  ensureSession,
  onOpenConversation,
}: {
  session?: AgentSession;
  projectId: string;
  disabled?: boolean;
  ensureSession: () => Promise<AgentSession>;
  onOpenConversation: (sessionId: string) => void;
}) {
  const { repositories, reload } = useWorkspaceGit(projectId, session?.id);
  const dirtyRepositories = repositories.filter(
    (repository) => repository.status === "ready" && repository.dirty,
  );
  const showCommit = dirtyRepositories.length > 0;
  const pushRepositories = repositories.filter(
    (repository) =>
      repository.status === "ready" &&
      (repository.unpushedCommitCount ?? 0) > 0,
  );
  const showPush = pushRepositories.length > 0;
  const showPr = showPush;
  const [intent, setIntent] = useState<"pr" | null>(null);
  const [owner, setOwner] = useState<AgentSession | null>(null);
  const [commitTarget, setCommitTarget] = useState<WorkspaceRepositoryGit | null>(
    null,
  );
  const [pushTarget, setPushTarget] = useState<WorkspaceRepositoryGit | null>(null);
  const [pushOpen, setPushOpen] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [commitOpen, setCommitOpen] = useState(false);
  const generation = useRef(0);
  const creating = useRef<Promise<AgentSession> | null>(null);
  useEffect(() => {
    generation.current++;
    setIntent(null);
    setCommitOpen(false);
    setCommitTarget(null);
    setPushOpen(false);
    setPushTarget(null);
    setOwner(null);
    setLoading(false);
    setError("");
    creating.current = null;
    return () => {
      generation.current++;
    };
  }, [projectId, session?.id]);
  const open = async (mode: "commit" | "pr" | "push") => {
    if (disabled || loading) return;
    const version = generation.current;
    setLoading(true);
    setError("");
    try {
      const next = session ?? (await (creating.current ??= ensureSession()));
      if (version !== generation.current) return;
      setOwner(next);
      if (mode === "commit") {
        const target =
          dirtyRepositories.find((repository) => repository.role === "primary") ??
          dirtyRepositories[0];
        if (!target) return;
        setCommitTarget(target);
        setCommitOpen(true);
      } else if (mode === "push") {
        const target =
          pushRepositories.find((repository) => repository.role === "primary") ??
          pushRepositories[0];
        if (!target) return;
        setPushTarget(target);
        setPushOpen(true);
      } else {
        setIntent(mode);
      }
    } catch (e) {
      if (version === generation.current) {
        setError(e instanceof Error ? e.message : String(e));
        creating.current = null;
      }
    } finally {
      if (version === generation.current) setLoading(false);
    }
  };
  if (!showCommit && !showPr && !showPush && !intent && !commitOpen && !pushOpen && !loading && !error)
    return null;
  return (
    <div className="composer-git-actions-wrap">
      {(showCommit || showPr || loading) && (
        <div
          className="composer-git-actions"
          role="group"
          aria-label="Git 操作"
        >
          {showCommit && (
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled || loading}
              onClick={() => void open("commit")}
              title="本地提交与分支处理"
            >
              <GitCommitHorizontal size={14} />
              <span>Commit</span>
            </Button>
          )}
          {showPush && (
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled || loading}
              onClick={() => void open("push")}
              title="审阅并推送本地提交"
            >
              <Upload size={14} />
              <span>Push</span>
            </Button>
          )}
          {showPr && (
            <Button
              variant="ghost"
              size="sm"
              disabled={disabled || loading}
              onClick={() => void open("pr")}
              title="GitHub PR / GitLab MR 与远程同步"
            >
              <GitPullRequest size={14} />
              <span>PR</span>
            </Button>
          )}
          {loading && (
            <LoaderCircle
              size={13}
              className="git-actions-spin"
              aria-label="正在打开 Git 工作区"
            />
          )}
        </div>
      )}
      {error && (
        <p className="git-actions-error" role="alert">
          {error}
        </p>
      )}
      {intent && owner && (
        <Suspense
          fallback={
            <span role="status" className="text-xs text-muted-foreground">
              正在加载 Git 面板…
            </span>
          }
        >
          <GitActionDialog
            key={`${owner.id}:${intent}`}
            intent={intent}
            session={owner}
            onClose={() => setIntent(null)}
            onTaskReady={() => {
              setIntent(null);
              onOpenConversation(owner.id);
            }}
          />
        </Suspense>
      )}
      {commitOpen && owner && commitTarget && (
        <SessionCommitDialog
          isOpen
          sessionId={owner.id}
          projectId={projectId}
          rootId={commitTarget.rootId}
          rootName={commitTarget.name}
          branch={commitTarget.branch}
          changedFiles={commitTarget.changedFiles?.length ?? 0}
          repositories={dirtyRepositories}
          onClose={() => {
            setCommitOpen(false);
            setCommitTarget(null);
          }}
          onCommitted={() => void reload?.()}
        />
      )}
      {pushOpen && owner && pushTarget && (
        <SessionPushDialog
          isOpen
          sessionId={owner.id}
          rootId={pushTarget.rootId}
          rootName={pushTarget.name}
          branch={pushTarget.branch}
          pendingCount={pushTarget.unpushedCommitCount}
          repositories={pushRepositories}
          onClose={() => {
            setPushOpen(false);
            setPushTarget(null);
          }}
          onPushed={() => void reload?.()}
        />
      )}
    </div>
  );
}
