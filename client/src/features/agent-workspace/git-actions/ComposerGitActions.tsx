import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  GitCommitHorizontal,
  GitPullRequest,
  LoaderCircle,
} from "lucide-react";
import { Button } from "../../../shared/ui/ui/Button";
import type { AgentSession } from "../../../adapters/transport/agentRuntime";
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
  const [intent, setIntent] = useState<"commit" | "pr" | null>(null);
  const [owner, setOwner] = useState<AgentSession | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const creating = useRef<Promise<AgentSession> | null>(null);
  useEffect(() => {
    generation.current++;
    setIntent(null);
    setOwner(null);
    setLoading(false);
    setError("");
    creating.current = null;
    return () => {
      generation.current++;
    };
  }, [projectId, session?.id]);
  const open = async (mode: "commit" | "pr") => {
    if (disabled || loading) return;
    const version = generation.current;
    setLoading(true);
    setError("");
    try {
      const next = session ?? (await (creating.current ??= ensureSession()));
      if (version !== generation.current) return;
      setOwner(next);
      setIntent(mode);
    } catch (e) {
      if (version === generation.current) {
        setError(e instanceof Error ? e.message : String(e));
        creating.current = null;
      }
    } finally {
      if (version === generation.current) setLoading(false);
    }
  };
  return (
    <div className="composer-git-actions-wrap">
      <div className="composer-git-actions" role="group" aria-label="Git 操作">
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
        {loading && (
          <LoaderCircle
            size={13}
            className="git-actions-spin"
            aria-label="正在打开 Git 工作区"
          />
        )}
      </div>
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
    </div>
  );
}
