import { AlertCircle, CheckCircle2, CloudUpload, GitBranch, LoaderCircle, RefreshCw } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import {
  Dialog, DialogBody, DialogCloseButton, DialogContainer, DialogFooter,
  DialogHeader, DialogIcon, DialogPanel, DialogTitle,
} from "../../shared/ui/ui/Dialog";
import { Button } from "../../shared/ui/ui/Button";
import { AppSelect } from "../../shared/ui/AppSelect";
import { agentRuntimeApi, type SessionGitCommitsToPushResult } from "../../adapters/transport/agentRuntime";
import { useLocale } from "../../shared/hooks/useLocale";
import { refreshWorkspace } from "./workspaceRefresh";

interface PushRepositoryOption {
  rootId: string;
  name: string;
  branch: string;
  unpushedCommitCount?: number;
}

interface Props {
  isOpen: boolean;
  sessionId: string;
  rootId?: string;
  rootName?: string;
  branch: string;
  pendingCount?: number;
  repositories?: PushRepositoryOption[];
  onClose: () => void;
  onPushed: () => void | Promise<void>;
}

export function SessionPushDialog(props: Props) {
  return props.isOpen ? (
    <PushReview key={`${props.sessionId}:${props.rootId ?? "primary"}`} {...props} />
  ) : null;
}

function PushReview({ sessionId, rootId, rootName, branch, repositories, onClose, onPushed }: Props) {
  const { t, locale } = useLocale();
  // Keep the reviewed repository selectable after a refresh removes its pending count.
  const [options] = useState(() => repositories ?? []);
  const [targetRootId, setTargetRootId] = useState(rootId ?? options[0]?.rootId);
  const selected = options.find((option) => option.rootId === targetRootId);
  const [review, setReview] = useState<SessionGitCommitsToPushResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pushed, setPushed] = useState(false);
  const [revision, setRevision] = useState(0);
  const generation = useRef(0);
  const locked = useRef(false);
  const dates = new Intl.DateTimeFormat(locale === "zh" ? "zh-CN" : "en-US", {
    dateStyle: "medium", timeStyle: "short",
  });

  useEffect(() => {
    const version = ++generation.current;
    const controller = new AbortController();
    locked.current = false;
    setReview(null);
    setError(null);
    setPushed(false);
    setSubmitting(false);
    setLoading(true);
    void agentRuntimeApi.listSessionWorkspaceCommits(sessionId, targetRootId, controller.signal)
      .then((result) => {
        if (version === generation.current) setReview(result);
      })
      .catch((cause) => {
        if (version === generation.current) setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (version === generation.current) setLoading(false);
      });
    return () => {
      generation.current++;
      controller.abort();
    };
  }, [sessionId, targetRootId, revision]);

  const refresh = () => {
    setReview(null);
    setLoading(true);
    setRevision((value) => value + 1);
  };

  const runPush = async () => {
    if (locked.current || loading || pushed || !review?.commits.length) return;
    locked.current = true;
    const version = generation.current;
    setSubmitting(true);
    setError(null);
    try {
      await agentRuntimeApi.pushSessionWorkspace(sessionId, {
        rootId: review.rootId,
        expectedHeadSha: review.headCommitSha,
        expectedBranch: review.branch,
        expectedUpstream: review.upstream,
      });
      if (version !== generation.current) return;
      setPushed(true);
      refreshWorkspace(sessionId, review.rootId);
      // A cache refresh failure must not turn a successful push into a retry.
      void Promise.resolve().then(onPushed).catch(() => {});
    } catch (cause) {
      if (version !== generation.current) return;
      setError(cause instanceof Error ? cause.message : String(cause));
      setReview(null);
    } finally {
      if (version === generation.current) {
        locked.current = false;
        setSubmitting(false);
      }
    }
  };

  return (
    <Dialog open onClose={onClose} dismissible={!submitting}>
      <DialogContainer size="md">
        <DialogPanel>
          <DialogCloseButton disabled={submitting} aria-label={t("workspacePushClose")} />
          <DialogHeader>
            <DialogIcon className="bg-primary/10 text-primary"><CloudUpload size={18} /></DialogIcon>
            <div className="min-w-0">
              <DialogTitle>{t("workspacePushTitle")}</DialogTitle>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{t("workspacePushDescription")}</p>
            </div>
          </DialogHeader>
          <DialogBody className="space-y-4">
            {options.length > 1 ? (
              <AppSelect
                label={t("workspaceRepositorySelect")}
                value={targetRootId ?? null}
                isDisabled={submitting}
                options={options.map((option) => ({ key: option.rootId, label: option.name }))}
                onChange={(value) => {
                  if (!value || value === targetRootId) return;
                  setReview(null);
                  setLoading(true);
                  setTargetRootId(value);
                }}
              />
            ) : (selected?.name || rootName) && (
              <p className="text-xs font-medium [overflow-wrap:anywhere]">{selected?.name || rootName}</p>
            )}
            <div className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-border/50 bg-secondary/35 px-3 py-2.5">
              <div className="flex min-w-0 items-center gap-2 text-xs">
                <GitBranch size={13} className="shrink-0 text-primary" aria-hidden="true" />
                <span className="font-mono [overflow-wrap:anywhere]">{review?.branch || selected?.branch || branch}</span>
              </div>
              {review && <span className="shrink-0 text-xs text-muted-foreground">{t("workspacePushCommitCount", { count: review.commits.length })}</span>}
            </div>
            {review && (
              <p className="text-xs text-muted-foreground [overflow-wrap:anywhere]">
                {t("workspacePushTarget")}: <span className="font-mono">{review.upstream}</span>
              </p>
            )}
            {loading ? (
              <div className="flex items-center justify-center gap-2 rounded-lg border border-border/50 px-3 py-8 text-xs text-muted-foreground" role="status">
                <LoaderCircle size={14} className="animate-spin motion-reduce:animate-none" aria-hidden="true" />
                {t("workspacePushLoading")}
              </div>
            ) : review?.commits.length ? (
              <ul className="max-h-72 overflow-y-auto rounded-lg border border-border/50" aria-label={t("workspacePushCommitList")}>
                {review.commits.map((commit) => (
                  <li key={commit.sha} className="space-y-2 border-b border-border/50 px-3 py-3 last:border-b-0">
                    <p className="text-sm font-medium leading-relaxed [overflow-wrap:anywhere]">{commit.subject || t("workspacePushNoSubject")}</p>
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted-foreground">
                      <code title={commit.sha}>{commit.sha.slice(0, 8)}</code>
                      <span className="[overflow-wrap:anywhere]">{commit.author || commit.email || t("workspacePushUnknownAuthor")}</span>
                      {Number.isFinite(Date.parse(commit.authoredAt)) && <time dateTime={commit.authoredAt}>{dates.format(new Date(commit.authoredAt))}</time>}
                    </div>
                    {commit.body && (
                      <details className="text-xs text-muted-foreground">
                        <summary className="cursor-pointer py-1 focus-visible:outline-2 focus-visible:outline-ring">{t("workspacePushCommitDetails")}</summary>
                        <p className="mt-1 whitespace-pre-wrap leading-relaxed [overflow-wrap:anywhere]">{commit.body}</p>
                      </details>
                    )}
                  </li>
                ))}
              </ul>
            ) : review && (
              <p className="rounded-lg border border-border/50 px-3 py-4 text-xs text-muted-foreground">{t("workspacePushNoCommits")}</p>
            )}
            {error && (
              <p role="alert" data-error-toast="off" className="flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/5 px-3 py-2 text-xs leading-relaxed text-destructive">
                <AlertCircle size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                <span className="min-w-0 [overflow-wrap:anywhere]">{error}</span>
              </p>
            )}
            {pushed && (
              <p role="status" className="flex items-start gap-2 rounded-md border border-success/30 bg-success/[0.06] px-3 py-2 text-xs leading-relaxed text-success">
                <CheckCircle2 size={14} className="mt-0.5 shrink-0" aria-hidden="true" />
                <span>{t("workspacePushSuccess")}</span>
              </p>
            )}
          </DialogBody>
          <DialogFooter>
            {pushed ? (
              <Button variant="primary" size="sm" onClick={onClose}>{t("workspaceCommitDone")}</Button>
            ) : (
              <>
                <Button variant="ghost" size="sm" className="mr-auto" disabled={loading || submitting} onClick={refresh}>
                  <RefreshCw size={13} aria-hidden="true" />{t("workspacePushRefresh")}
                </Button>
                <Button variant="ghost" size="sm" onClick={onClose} disabled={submitting}>{t("workspaceCommitCancel")}</Button>
                <Button variant="primary" size="sm" onClick={() => void runPush()} pending={submitting} disabled={loading || !review?.commits.length}>
                  <CloudUpload size={14} aria-hidden="true" />{t("workspacePushOnly")}
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogPanel>
      </DialogContainer>
    </Dialog>
  );
}
