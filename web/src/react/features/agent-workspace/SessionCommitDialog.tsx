import { Button, Checkbox, Modal, TextArea, Tooltip } from "@heroui/react";
import { AppSelect } from "../../components/AppSelect";
import {
  AlertCircle,
  CheckCircle2,
  GitBranch,
  GitCommit,
  Sparkles,
  X,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import {
  agentRuntimeApi,
  type SessionGitCommitResult,
} from "../../../lib/api/agentRuntime";
import { useLocale } from "../../../hooks/useLocale";
import { useConfig } from "../settings/useConfig";
import { useAgentSessionStore } from "./state/agentSessionStore";
import { sessionRuntimeSelection } from "./sessionRuntimeSelection";
import {
  buildAgentModelOptions,
  formatModelReference,
} from "./composer/modelSelection";
import {
  pickCommitMessageModel,
  useCommitModelPreference,
} from "./commitMessageModelPreference";

const EMPTY_RUNS: import("../../../lib/api/agentRuntime").AgentRun[] = [];
const EMPTY_STEPS: import("../../../lib/api/agentRuntime").AgentRunStep[] = [];

interface Props {
  isOpen: boolean;
  sessionId: string | null;
  projectId: string;
  rootId?: string;
  rootName?: string;
  branch: string;
  changedFiles: number;
  onClose: () => void;
  onCommitted: (result: SessionGitCommitResult) => void;
}

/**
 * Commit the session workspace on its current branch, optionally pushing it.
 *
 * Message generation is an explicit, cancellable preview separate from committing.
 */
export function SessionCommitDialog({
  isOpen,
  sessionId,
  projectId,
  rootId,
  rootName,
  branch,
  changedFiles,
  onClose,
  onCommitted,
}: Props) {
  const { t } = useLocale();
  const { globalConfig, providers } = useConfig(projectId);
  const apiModels = useMemo(
    () => buildAgentModelOptions(globalConfig, providers).apiModels,
    [globalConfig, providers],
  );
  const session = useAgentSessionStore((state) =>
    state.sessions.find((item) => item.id === sessionId),
  );
  const runs = useAgentSessionStore((state) =>
    state.selectedSessionId === sessionId
      ? state.runs
      : (state.sessionDetailCache[sessionId ?? ""]?.runs ?? EMPTY_RUNS),
  );
  const steps = useAgentSessionStore((state) =>
    state.selectedSessionId === sessionId
      ? state.steps
      : (state.sessionDetailCache[sessionId ?? ""]?.steps ?? EMPTY_STEPS),
  );
  const sessionModel = sessionRuntimeSelection(session, runs, steps).model;
  const remembered = useCommitModelPreference(
    (state) => state.byProject[projectId] ?? null,
  );
  const remember = useCommitModelPreference((state) => state.remember);
  const selectedModel = pickCommitMessageModel(
    apiModels,
    sessionModel,
    remembered,
  );
  const selectedModelRef = selectedModel
    ? formatModelReference(selectedModel.providerId, selectedModel.modelId)
    : null;
  const [message, setMessage] = useState("");
  const [includeUntracked, setIncludeUntracked] = useState(true);
  const [submitting, setSubmitting] = useState<"commit" | "push" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<SessionGitCommitResult | null>(null);
  const [generating, setGenerating] = useState(false);
  const streamController = useRef<AbortController | null>(null);
  const priorMessage = useRef("");
  const frame = useRef<number | null>(null);
  const generation = useRef(0);
  const locked = useRef(false);

  // Each open starts from a clean form instead of replaying the last attempt.
  useEffect(() => {
    generation.current += 1;
    locked.current = false;
    setMessage("");
    setIncludeUntracked(true);
    setGenerating(false);
    setError(null);
    setResult(null);
    setSubmitting(null);
    return () => {
      generation.current += 1;
      streamController.current?.abort();
      streamController.current = null;
      if (frame.current !== null) cancelAnimationFrame(frame.current);
      frame.current = null;
      locked.current = false;
    };
  }, [isOpen, sessionId, projectId, rootId]);

  const cancelGeneration = () => {
    if (!streamController.current) return;
    generation.current += 1;
    streamController.current.abort();
    streamController.current = null;
    if (frame.current !== null) cancelAnimationFrame(frame.current);
    frame.current = null;
    setMessage(priorMessage.current);
    setGenerating(false);
  };

  const generate = async () => {
    if (
      !sessionId ||
      !isOpen ||
      !selectedModelRef ||
      generating ||
      streamController.current ||
      locked.current
    )
      return;
    const controller = new AbortController();
    streamController.current = controller;
    const request = ++generation.current;
    priorMessage.current = message;
    setMessage("");
    setError(null);
    setGenerating(true);
    let accumulated = "";
    try {
      await agentRuntimeApi.streamCommitMessage(
        sessionId,
        { ...(rootId ? { rootId } : {}), model: selectedModelRef },
        (event) => {
          if (request !== generation.current || controller.signal.aborted)
            return;
          if (event.type === "delta") {
            accumulated += event.text;
            if (frame.current === null)
              frame.current = requestAnimationFrame(() => {
                frame.current = null;
                if (request === generation.current) setMessage(accumulated);
              });
          } else {
            if (frame.current !== null) cancelAnimationFrame(frame.current);
            frame.current = null;
            setMessage(event.message);
          }
        },
        controller.signal,
      );
    } catch (err) {
      if (request !== generation.current || controller.signal.aborted) return;
      setMessage(priorMessage.current);
      setError(
        err instanceof Error ? err.message : t("workspaceCommitGenerateFailed"),
      );
    } finally {
      if (request === generation.current) {
        if (frame.current !== null) cancelAnimationFrame(frame.current);
        frame.current = null;
        streamController.current = null;
        setGenerating(false);
      }
    }
  };

  const run = async (push: boolean) => {
    if (!sessionId || !isOpen || locked.current || generating) return;
    if (!message.trim()) {
      setError(t("workspaceCommitMessageRequired"));
      return;
    }
    locked.current = true;
    const request = generation.current;
    setSubmitting(push ? "push" : "commit");
    setError(null);
    try {
      const trimmed = message.trim();
      const committed = await agentRuntimeApi.commitSessionWorkspace(
        sessionId,
        {
          ...(rootId ? { rootId } : {}),
          message: trimmed,
          ...(push ? {} : { push: false }),
          ...(includeUntracked ? {} : { includeUntracked: false }),
        },
      );
      if (generation.current !== request) return;
      setResult(committed);
      onCommitted(committed);
    } catch (err) {
      if (generation.current !== request) return;
      setError(
        err instanceof Error && err.message
          ? err.message
          : push
            ? t("workspaceCommitPush")
            : t("workspaceCommitOnly"),
      );
    } finally {
      if (generation.current === request) {
        locked.current = false;
        setSubmitting(null);
      }
    }
  };

  const handleOpenChange = (open: boolean) => {
    if (!open && !submitting) {
      cancelGeneration();
      onClose();
    }
  };

  const busy = submitting !== null;
  const upstream = result?.upstream ?? branch;
  const pushed = result?.pushed === true;

  return (
    <Modal.Backdrop isOpen={isOpen} onOpenChange={handleOpenChange}>
      <Modal.Container size="sm">
        <Modal.Dialog className="sm:max-w-lg">
          <Modal.CloseTrigger />
          <Modal.Header>
            <Modal.Icon className="bg-primary/10 text-primary">
              <GitCommit size={18} />
            </Modal.Icon>
            <Modal.Heading>{t("workspaceCommitTitle")}</Modal.Heading>
          </Modal.Header>
          <Modal.Body className="space-y-4">
            {rootName && (
              <p className="text-xs font-medium" title={rootName}>
                {rootName}
              </p>
            )}
            {result ? (
              <div
                role="status"
                className="flex items-start gap-3 rounded-lg border border-success/30 bg-success/[0.06] px-3 py-3"
              >
                <CheckCircle2
                  size={15}
                  className="mt-0.5 shrink-0 text-success"
                />
                <div className="min-w-0 space-y-1.5">
                  <p className="text-xs leading-relaxed text-foreground/90">
                    {pushed
                      ? t("workspaceCommitSuccess", {
                          sha: result.commitSha.slice(0, 8),
                        })
                      : t("workspaceCommitLocalSuccess", {
                          sha: result.commitSha.slice(0, 8),
                        })}
                  </p>
                  {!pushed ? (
                    <p className="text-[10px] leading-relaxed text-muted-foreground">
                      {t("workspaceCommitLocalHint")}
                    </p>
                  ) : null}
                  <p className="flex min-w-0 items-center gap-1.5 text-[10px] text-muted-foreground">
                    <GitBranch size={10} className="shrink-0" />
                    <span className="truncate font-mono">{upstream}</span>
                  </p>
                  <p
                    className="truncate font-mono text-[10px] leading-relaxed text-foreground/70"
                    title={result.message}
                  >
                    {result.message}
                  </p>
                </div>
              </div>
            ) : (
              <>
                {/* Target summary: which branch receives the commit, and how much is pending. */}
                <div className="flex items-center justify-between gap-3 rounded-lg border border-border/40 bg-secondary/40 px-3 py-2">
                  <span className="flex min-w-0 items-center gap-1.5 text-[11px]">
                    <GitBranch size={11} className="shrink-0 text-primary" />
                    <span
                      className="truncate font-mono text-foreground/85"
                      title={branch}
                    >
                      {branch}
                    </span>
                  </span>
                  <span className="shrink-0 text-[11px] text-muted-foreground">
                    {changedFiles > 0
                      ? t("workspaceCommitChangedFiles", {
                          count: changedFiles,
                        })
                      : t("workspaceCommitNoChanges")}
                  </span>
                </div>

                {/* Untracked files only join the commit when explicitly chosen. */}
                <label className="flex cursor-pointer items-center gap-2 px-1 text-[11px] text-muted-foreground">
                  <Checkbox
                    isSelected={includeUntracked}
                    onChange={setIncludeUntracked}
                    isDisabled={busy}
                    aria-label={t("workspaceCommitIncludeUntracked")}
                  >
                    <Checkbox.Content>
                      <Checkbox.Control>
                        <Checkbox.Indicator />
                      </Checkbox.Control>
                    </Checkbox.Content>
                  </Checkbox>
                  <span>{t("workspaceCommitIncludeUntracked")}</span>
                </label>

                <div className="space-y-1.5">
                  <div className="flex items-center justify-between gap-2">
                    <label
                      className="text-xs font-medium text-foreground/85"
                      htmlFor="session-commit-message"
                    >
                      {t("workspaceCommitMessageLabel")}
                    </label>
                    <div className="flex min-w-0 items-center gap-2 text-[11px] text-muted-foreground">
                      <span>{t("workspaceCommitModel")}</span>
                      <AppSelect
                        aria-label={t("workspaceCommitModel")}
                        className="max-w-44"
                        fullWidth={false}
                        value={selectedModelRef ?? null}
                        isDisabled={busy || apiModels.length === 0}
                        placeholder={t("workspaceCommitNoModel")}
                        onChange={(value) => {
                          if (!value) return;
                          cancelGeneration();
                          remember(projectId, value);
                        }}
                        options={apiModels.map((option) => ({
                          key: formatModelReference(
                            option.providerId,
                            option.modelId,
                          )!,
                          label: `${option.providerId} / ${option.label}`,
                        }))}
                      />
                    </div>
                  </div>
                  <div className="relative">
                    <TextArea
                      id="session-commit-message"
                      aria-label={t("workspaceCommitMessageLabel")}
                      value={message}
                      onChange={(event) => setMessage(event.target.value)}
                      placeholder={t("workspaceCommitMessagePlaceholder")}
                      rows={4}
                      fullWidth
                      disabled={generating || busy}
                      className="pr-12 text-xs"
                    />
                    <div className="absolute right-2 top-2">
                      {generating ? (
                        <Tooltip delay={300}>
                          <Button
                            isIconOnly
                            variant="ghost"
                            size="sm"
                            onPress={cancelGeneration}
                            aria-label={t("workspaceCommitStopGenerating")}
                          >
                            <X size={14} />
                          </Button>
                          <Tooltip.Content>
                            {t("workspaceCommitStopGenerating")}
                          </Tooltip.Content>
                        </Tooltip>
                      ) : (
                        <Tooltip delay={300}>
                          <Button
                            isIconOnly
                            variant="ghost"
                            size="sm"
                            onPress={() => void generate()}
                            isDisabled={
                              !selectedModelRef || changedFiles === 0 || busy
                            }
                            aria-label={t("workspaceCommitGenerate")}
                          >
                            <Sparkles size={14} />
                          </Button>
                          <Tooltip.Content>
                            {t("workspaceCommitGenerate")}
                          </Tooltip.Content>
                        </Tooltip>
                      )}
                    </div>
                  </div>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    {t("workspaceCommitMessageHint")}
                  </p>
                </div>

                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  {t("workspaceCommitActionHint")}
                </p>

                {error ? (
                  <p
                    role="alert"
                    className="flex items-start gap-2 rounded-md border border-destructive/25 bg-destructive/5 px-3 py-2 text-[11px] leading-relaxed text-destructive"
                  >
                    <AlertCircle size={12} className="mt-[2px] shrink-0" />
                    <span className="min-w-0 break-words">{error}</span>
                  </p>
                ) : null}
              </>
            )}
          </Modal.Body>
          <Modal.Footer className="flex-col items-stretch gap-2 sm:flex-row sm:items-center sm:justify-between">
            {result ? (
              <Button
                variant="primary"
                size="sm"
                onPress={onClose}
                className="sm:ml-auto"
              >
                {t("workspaceCommitDone")}
              </Button>
            ) : (
              <>
                <Button
                  variant="ghost"
                  size="sm"
                  onPress={onClose}
                  isDisabled={busy}
                  className="sm:mr-auto"
                >
                  {t("workspaceCommitCancel")}
                </Button>
                <div className="flex items-center justify-end gap-2">
                  <Button
                    variant="secondary"
                    size="sm"
                    onPress={() => void run(false)}
                    isPending={submitting === "commit"}
                    isDisabled={
                      !sessionId ||
                      changedFiles === 0 ||
                      submitting === "push" ||
                      generating
                    }
                  >
                    {t("workspaceCommitOnly")}
                  </Button>
                  <Button
                    variant="primary"
                    size="sm"
                    onPress={() => void run(true)}
                    isPending={submitting === "push"}
                    isDisabled={
                      !sessionId ||
                      changedFiles === 0 ||
                      submitting === "commit" ||
                      generating
                    }
                  >
                    {t("workspaceCommitPush")}
                  </Button>
                </div>
              </>
            )}
          </Modal.Footer>
        </Modal.Dialog>
      </Modal.Container>
    </Modal.Backdrop>
  );
}
