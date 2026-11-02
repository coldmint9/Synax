import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  GitCommitHorizontal,
  GitMerge,
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
import {
  remotePrApi,
  type PrProvider,
} from "../../../adapters/transport/remotePr";
import { mergeRequestTerms } from "./mrTerms";
import "./gitActions.css";
const GitActionDialog = lazy(() => import("./GitActionDialog"));
/** The merge-request entry beside the composer input is hidden for now. The Git
 * workbench still owns the full MR surface, so only this button is gated. */
export const COMPOSER_MR_ENTRY_VISIBLE = false;
export default function ComposerGitActions({
  session,
  projectId,
  inline = false,
  disabled = false,
  ensureSession,
  onOpenConversation,
}: {
  session?: AgentSession;
  projectId: string;
  /** Rendered beside another action in one row; the row owns the spacing. */
  inline?: boolean;
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
  // Pending commits surface Push only while the MR entry stays hidden.
  const showPr = COMPOSER_MR_ENTRY_VISIBLE && showPush;
  const [intent, setIntent] = useState<"mr" | null>(null);
  const [provider, setProvider] = useState<PrProvider | null>(null);
  const terms = mergeRequestTerms(provider ?? undefined);
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
    setProvider(null);
    creating.current = null;
    return () => {
      generation.current++;
    };
  }, [projectId, session?.id]);
  // The MR button must name the platform this checkout publishes to.
  useEffect(() => {
    if (!showPr || !session) return;
    let active = true;
    void remotePrApi
      .discover(session.id)
      .then((data) => {
        if (!active) return;
        const first =
          data.remotes.find(
            (remote) => remote.name === "origin" && remote.provider,
          ) ?? data.remotes.find((remote) => remote.provider);
        setProvider(first?.provider ?? null);
      })
      .catch(() => {
        /* The dialog resolves the provider when it opens. */
      });
    return () => {
      active = false;
    };
  }, [showPr, session?.id]);
  const open = async (mode: "commit" | "mr" | "push") => {
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
    <div
      className={
        inline ? "composer-git-actions-wrap is-inline" : "composer-git-actions-wrap"
      }
    >
      {(showCommit || showPush || loading) && (
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
              onClick={() => void open("mr")}
              title={`${terms.full} · 合并与远程同步`}
            >
              {terms.short === "MR" ? (
                <GitMerge size={14} />
              ) : (
                <GitPullRequest size={14} />
              )}
              <span>{terms.short}</span>
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
