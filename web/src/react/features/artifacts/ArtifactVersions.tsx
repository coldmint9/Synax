import { useEffect, useRef, useState } from "react";
import type {
  ArtifactReference,
  ArtifactRevision,
  ArtifactState,
} from "../../../../../api/services/agent-runtime/artifacts/contracts";
import {
  artifactVersionsApi,
  type ArtifactVersionHistory,
  type StateInheritanceInspection,
} from "../../../lib/api/artifactVersions";
import { useLocale } from "../../../hooks/useLocale";

export interface VersionActionsProps {
  sessionId: string;
  reference: ArtifactReference;
  onForkPublished: (revision: ArtifactRevision) => void;
  onStateInherited: (state: ArtifactState) => void;
}
/** Remount on identity change: a late response must never update a different card/session. */
export function VersionActions(props: VersionActionsProps): React.JSX.Element {
  return (
    <VersionActionsPanel
      key={JSON.stringify([
        props.sessionId,
        props.reference.artifactId,
        props.reference.revisionId,
      ])}
      {...props}
    />
  );
}
function VersionActionsPanel({
  sessionId,
  reference,
  onForkPublished,
  onStateInherited,
}: VersionActionsProps): React.JSX.Element {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const text = (en: string, cn: string) => (zh ? cn : en);
  const [history, setHistory] = useState<ArtifactVersionHistory | null>(null);
  const [selected, setSelected] = useState(reference.revisionId);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [forkOpen, setForkOpen] = useState(false);
  const [title, setTitle] = useState(`${reference.title.slice(0, 190)} branch`);
  const [review, setReview] = useState<StateInheritanceInspection | null>(null);
  const [includePrivate, setIncludePrivate] = useState(false);
  const [includeModel, setIncludeModel] = useState(false);
  const [confirmSensitive, setConfirmSensitive] = useState(false);
  const active = useRef(false);
  const working = useRef(false);
  // Retain a retry key after an ambiguous network failure; only a changed request gets a new key.
  const forkRequest = useRef<{ identity: string; key: string } | null>(null);
  const showError = (cause: unknown) =>
    setError(
      cause instanceof Error
        ? cause.message
        : text("Artifact operation failed.", "操作失败。"),
    );
  useEffect(() => {
    active.current = true;
    void artifactVersionsApi
      .history(sessionId, reference.artifactId)
      .then((value) => {
        if (active.current) setHistory(value);
      })
      .catch((cause) => {
        if (active.current) showError(cause);
      });
    return () => {
      active.current = false;
    };
  }, [sessionId, reference.artifactId]);
  async function perform(operation: () => Promise<void>) {
    if (working.current) return;
    working.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      await operation();
    } catch (cause) {
      if (active.current) showError(cause);
    } finally {
      working.current = false;
      if (active.current) setBusy(false);
    }
  }
  function resetReview() {
    setReview(null);
    setIncludePrivate(false);
    setIncludeModel(false);
    setConfirmSensitive(false);
  }
  async function publishFork() {
    const normalizedTitle = title.trim();
    if (!normalizedTitle) return;
    await perform(async () => {
      const identity = JSON.stringify([selected, normalizedTitle]);
      if (forkRequest.current?.identity !== identity)
        forkRequest.current = { identity, key: crypto.randomUUID() };
      const { revision } = await artifactVersionsApi.fork(sessionId, selected, {
        title: normalizedTitle,
        idempotencyKey: forkRequest.current.key,
      });
      if (!active.current) return;
      setForkOpen(false);
      forkRequest.current = null;
      setNotice(
        text(
          "New branch published. The original history is unchanged.",
          "新分支已发布，原始历史未改变。",
        ),
      );
      onForkPublished(revision);
      const updated = await artifactVersionsApi.history(
        sessionId,
        reference.artifactId,
      );
      if (active.current) setHistory(updated);
    });
  }
  async function inspect() {
    resetReview();
    await perform(async () => {
      const result = await artifactVersionsApi.inspectInheritance(
        sessionId,
        reference.revisionId,
        selected,
      );
      if (!active.current) return;
      if (!result.compatible)
        setError(
          result.reason ??
            text("State schemas are incompatible.", "状态架构不兼容。"),
        );
      else setReview(result);
    });
  }
  async function inherit() {
    if (!review || ((includePrivate || includeModel) && !confirmSensitive))
      return;
    await perform(async () => {
      try {
        const state = await artifactVersionsApi.inheritState(
          sessionId,
          reference.revisionId,
          {
            sourceRevisionId: review.sourceRevisionId,
            sourceEtag: review.sourceEtag,
            expectedEtag: review.expectedEtag,
            includePrivateState: includePrivate,
            includeModelState: includeModel,
            confirmSensitiveState: confirmSensitive,
          },
        );
        if (!active.current) return;
        resetReview();
        setNotice(
          text(
            "State inherited. Reloading the preview with saved state.",
            "状态已继承，将使用保存状态重新加载预览。",
          ),
        );
        onStateInherited(state);
      } catch (cause) {
        // Never retry a stale consent/CAS pair. The user must inspect and confirm again.
        if (active.current) resetReview();
        throw cause;
      }
    });
  }
  const candidates = history
    ? [
        ...new Map(
          [
            ...history.revisions,
            ...(history.derivedFrom ? [history.derivedFrom] : []),
            ...history.branches,
          ].map((r) => [r.revisionId, r]),
        ).values(),
      ]
    : [];
  const source = candidates.find((r) => r.revisionId === selected);
  const label = (r: ArtifactRevision) =>
    `${r.title} · v${r.revisionNumber} · ${r.artifactId.slice(0, 8)}`;
  return (
    <section
      className="artifact-versions artifact-qa"
      style={{ display: "grid", gap: 8, overflowWrap: "anywhere" }}
      aria-label={text("Version lineage and state", "版本分支与状态")}
      aria-busy={busy}
    >
      <h4>{text("Version lineage and state", "版本分支与状态")}</h4>
      <p>
        {text(
          "Publish an independent branch from a saved version. This never rewinds history, reads changed workspace files, or calls a model.",
          "从已保存版本发布独立分支；不会回退历史、读取工作区变化或调用模型。",
        )}
      </p>
      {history?.derivedFrom && (
        <p>
          {text("Derived from: ", "派生自：")}
          {label(history.derivedFrom)}
        </p>
      )}
      {!!history?.branches.length && (
        <p>
          {text("Branches: ", "分支：")}
          {history.branches.map(label).join("; ")}
        </p>
      )}
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {!history ? (
        <button
          type="button"
          disabled={busy}
          onClick={() =>
            void perform(async () => {
              const value = await artifactVersionsApi.history(
                sessionId,
                reference.artifactId,
              );
              if (active.current) setHistory(value);
            })
          }
        >
          {text("Reload version history", "重新加载版本历史")}
        </button>
      ) : (
        <>
          <label>
            {text("Source version", "来源版本")}
            <select
              value={selected}
              disabled={busy || forkOpen || !!review}
              onChange={(event) => {
                setSelected(event.target.value);
                resetReview();
                setError("");
                setNotice("");
              }}
            >
              {candidates.map((item) => (
                <option key={item.revisionId} value={item.revisionId}>
                  {label(item)}
                  {item.revisionId === reference.revisionId
                    ? text(" (viewing)", "（当前查看）")
                    : ""}
                </option>
              ))}
            </select>
          </label>
          <div
            className="artifact-actions"
            style={{ display: "flex", flexWrap: "wrap", gap: 8 }}
          >
            <button
              type="button"
              disabled={busy || !source || forkOpen || !!review}
              onClick={() => {
                setForkOpen(true);
                resetReview();
                setError("");
                setNotice("");
              }}
            >
              {text("Branch from selected version", "从所选版本创建分支")}
            </button>
            <button
              type="button"
              disabled={
                busy ||
                !source ||
                selected === reference.revisionId ||
                forkOpen ||
                !!review
              }
              onClick={() => void inspect()}
            >
              {text("Review state inheritance", "审查状态继承")}
            </button>
          </div>
          {forkOpen && (
            <fieldset
              disabled={busy}
              style={{
                display: "grid",
                gap: 8,
                minWidth: 0,
                border: "1px solid var(--border, #dedee5)",
                borderRadius: 6,
                padding: 12,
              }}
            >
              <legend>
                {text("Publish an independent branch", "发布独立分支")}
              </legend>
              <p>
                {text("Source: ", "来源：")}
                {source && label(source)}.{" "}
                {text(
                  "State starts empty. Inheritance is a separate, explicit action.",
                  "状态初始为空，继承需单独明确确认。",
                )}
              </p>
              <label>
                {text("Branch title", "分支标题")}
                <input
                  value={title}
                  maxLength={200}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </label>
              <button
                type="button"
                disabled={!title.trim() || busy}
                onClick={() => void publishFork()}
              >
                {text("Publish new branch", "发布新分支")}
              </button>
              <button type="button" onClick={() => setForkOpen(false)}>
                {text("Cancel", "取消")}
              </button>
            </fieldset>
          )}
          {review && (
            <fieldset
              disabled={busy}
              style={{
                display: "grid",
                gap: 8,
                minWidth: 0,
                border: "1px solid var(--border, #dedee5)",
                borderRadius: 6,
                padding: 12,
              }}
            >
              <legend>
                {text(
                  "Confirm compatible state inheritance",
                  "确认兼容状态继承",
                )}
              </legend>
              <p>
                {text(
                  "Replace controls on the viewed version using the selected source. Private and model-visible state remain unchanged unless selected below. No model call is made.",
                  "使用所选来源替换当前版本控件状态。除非下方明确选择，否则私有和模型可见状态保持不变。不会调用模型。",
                )}
              </p>
              <p>
                {text("Compatible controls: ", "兼容控件：")}
                {review.controlKeys.join(", ") || text("(none)", "（无）")}
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={includePrivate}
                  onChange={(event) => {
                    setIncludePrivate(event.target.checked);
                    setConfirmSensitive(false);
                  }}
                />
                {text("Also copy private state", "同时复制私有状态")}
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={includeModel}
                  onChange={(event) => {
                    setIncludeModel(event.target.checked);
                    setConfirmSensitive(false);
                  }}
                />
                {text("Also copy model-visible state", "同时复制模型可见状态")}
              </label>
              {(includePrivate || includeModel) && (
                <label>
                  <input
                    type="checkbox"
                    checked={confirmSensitive}
                    onChange={(event) =>
                      setConfirmSensitive(event.target.checked)
                    }
                  />
                  {text(
                    "I confirm copying the selected sensitive state",
                    "我确认复制所选敏感状态",
                  )}
                </label>
              )}
              <button
                type="button"
                disabled={
                  busy ||
                  ((includePrivate || includeModel) && !confirmSensitive)
                }
                onClick={() => void inherit()}
              >
                {text("Confirm state inheritance", "确认继承状态")}
              </button>
              <button type="button" onClick={resetReview}>
                {text("Cancel", "取消")}
              </button>
            </fieldset>
          )}
        </>
      )}
    </section>
  );
}
