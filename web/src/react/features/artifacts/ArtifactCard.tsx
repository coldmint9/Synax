import { VersionActions } from "./ArtifactVersions";
import { ArtifactCapture, ArtifactBoundsOverlay } from "./ArtifactCapture";
import {
  revokeScreenshot,
  screenshotFeedback,
  type ArtifactScreenshot,
} from "./capture";
import {
  acquirePreviewSlot,
  releasePreviewSlot,
  touchPreviewSlot,
} from "./preview-slots";
import { useLocale } from "../../../hooks/useLocale";
import { artifactText } from "./locale";
import { useEffect, useId, useRef, useState } from "react";
import {
  Code2,
  Download,
  Expand,
  FlaskConical,
  Maximize2,
  Pause,
  Play,
  RotateCcw,
  X,
} from "lucide-react";
import type {
  ArtifactBundle,
  ArtifactControl,
  ArtifactFeedbackInput,
  ArtifactReference,
  ArtifactRevision,
  ArtifactState,
} from "../../../../../api/services/agent-runtime/artifacts/contracts";
import { artifactsApi } from "../../../lib/api/artifacts";
import { ArtifactSourcePane } from "./ArtifactSourcePane";
import { ArtifactQaPane } from "./ArtifactQaPane";
import { ArtifactFeedbackConfirmation } from "./ArtifactFeedbackConfirmation";
import {
  feedbackInput,
  runtimeId,
  validateState,
  type FeedbackDraft,
} from "./bridge";
import { ArtifactRuntimeHost } from "./runtime-host";
import {
  desktopEnvironment,
  mountPreview,
  type PreviewConnection,
} from "./transport";
import "./artifacts.css";

const emptyState = (): ArtifactState => ({
  privateState: null,
  modelState: null,
  controls: {},
  schemaVersion: 1,
  etag: 0,
});
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Artifact request failed.";
export interface ArtifactCardProps {
  sessionId: string;
  reference: ArtifactReference;
}
export function ArtifactCard({ sessionId, reference }: ArtifactCardProps) {
  // Keying the inner card revokes the previous session/revision's ports and async work.
  return (
    <ArtifactCardSession
      key={`${sessionId}:${reference.artifactId}:${reference.revisionId}`}
      sessionId={sessionId}
      reference={reference}
    />
  );
}
function ArtifactCardSession({ sessionId, reference }: ArtifactCardProps) {
  const { locale } = useLocale();
  const translate = (text: string) => artifactText(locale, text);
  const [revisionId, setRevisionId] = useState(reference.revisionId);
  const [revisions, setRevisions] = useState<ArtifactRevision[]>([]);
  const [loaded, setLoaded] = useState<{
    bundle: ArtifactBundle;
    state: ArtifactState;
  } | null>(null);
  const [state, setState] = useState<ArtifactState>(emptyState);
  const stateRef = useRef(state);
  const [controls, setControls] = useState<ArtifactControl[]>([]);
  const [running, setRunning] = useState(false);
  const [connected, setConnected] = useState(false);
  const [savingState, setSavingState] = useState(false);
  const [reload, setReload] = useState(0);
  const [height, setHeight] = useState(380);
  const [autoHeight, setAutoHeight] = useState(true);
  const autoHeightRef = useRef(true);
  const [width, setWidth] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [tab, setTab] = useState<"preview" | "source" | "qa">("preview");
  const [compareId, setCompareId] = useState("");
  const [screenshot, setScreenshot] = useState<ArtifactScreenshot | null>(null);
  const screenshotRef = useRef<ArtifactScreenshot | null>(null);
  const replaceScreenshot = (next: ArtifactScreenshot | null) => {
    if (screenshotRef.current !== next) revokeScreenshot(screenshotRef.current);
    screenshotRef.current = next;
    setScreenshot(next);
  };
  const [draft, setDraft] = useState<FeedbackDraft>({ text: "" });
  const [review, setReview] = useState<ArtifactFeedbackInput | null>(null);
  const [sending, setSending] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const [stateError, setStateError] = useState("");
  const [logs, setLogs] = useState<Array<{ level: string; message: string }>>(
    [],
  );
  const [picking, setPicking] = useState(false);
  const container = useRef<HTMLDivElement>(null);
  const card = useRef<HTMLElement>(null);
  const connection = useRef<PreviewConnection | null>(null);
  const host = useRef<ArtifactRuntimeHost | null>(null);
  const reviewButton = useRef<HTMLButtonElement>(null);
  const alive = useRef(true);
  const uid = useId();
  const desktop = desktopEnvironment().desktop;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      revokeScreenshot(screenshotRef.current);
      releasePreviewSlot(uid);
    };
  }, []);
  useEffect(() => {
    let current = true;
    setLoaded(null);
    setError("");
    setStateError("");
    setSavingState(false);
    setControls([]);
    setLogs([]);
    setDraft({ text: "" });
    replaceScreenshot(null);
    setReview(null);
    setPicking(false);
    setNotice("");
    Promise.all([
      artifactsApi.bundle(sessionId, revisionId),
      artifactsApi.state(sessionId, revisionId),
    ])
      .then(([bundle, saved]) => {
        if (!current) return;
        if (
          bundle.revision.artifactId !== reference.artifactId ||
          bundle.revision.revisionId !== revisionId ||
          bundle.revision.sessionId !== sessionId
        )
          throw new Error("Artifact revision does not belong to this card.");
        const restored = validateState(saved);
        setLoaded({ bundle, state: restored });
        setState(restored);
        stateRef.current = restored;
      })
      .catch((error) => {
        if (current) {
          setError(errorText(error));
          setRunning(false);
        }
      });
    return () => {
      current = false;
    };
  }, [sessionId, revisionId, reload, reference.artifactId]);
  useEffect(() => {
    let current = true;
    artifactsApi
      .revisions(sessionId, reference.artifactId)
      .then((result) => {
        if (current) setRevisions(result.items);
      })
      .catch((error) => {
        if (current) setError(errorText(error));
      });
    return () => {
      current = false;
    };
  }, [sessionId, reference.artifactId, reload]);
  useEffect(() => {
    if (
      !running ||
      !loaded ||
      loaded.bundle.revision.revisionId !== revisionId ||
      loaded.bundle.revision.status !== "ready" ||
      !container.current
    )
      return;
    let current = true;
    setConnected(false);
    setError("");
    const controller = new ArtifactRuntimeHost({
      sessionId,
      revisionId,
      state: stateRef.current,
      onSaving: (saving) => {
        if (current) setSavingState(saving);
      },
      onState: (value) => {
        if (current) {
          stateRef.current = value;
          setState(value);
        }
      },
      onControls: (value) => {
        if (current) setControls(value);
      },
      onDraft: (value) => {
        if (current) {
          setDraft((previous) => ({ ...previous, ...value }));
          setPicking(false);
          if (Object.prototype.hasOwnProperty.call(value, "element"))
            void connection.current
              ?.annotate?.(value.element?.bounds ?? null)
              .catch((error) => setError(errorText(error)));
          setNotice(
            value.element
              ? translate("Element selected. Review it in QA.")
              : translate("Preview suggested feedback. Review it in QA."),
          );
        }
      },
      onLog: (value) => {
        if (current) setLogs(value);
      },
      onHeight: (value) => {
        if (current && autoHeightRef.current) setHeight(value);
      },
      onError: (message) => {
        if (current) setStateError(message);
      },
      send: (type, payload) => connection.current?.send(type, payload),
    });
    host.current = controller;
    const preview = mountPreview({
      container: container.current,
      html: loaded.bundle.html,
      revisionId,
      title: reference.title,
      onRequest: (type, payload) => controller.handle(type, payload),
      onConnected: () => {
        if (current) setConnected(true);
      },
      onError: (error) => {
        if (current) {
          setError(error.message);
          setRunning(false);
          setConnected(false);
        }
      },
    });
    connection.current = preview;
    const themeObserver = new MutationObserver(() =>
      preview.send("theme", {
        theme:
          document.documentElement.classList.contains("dark") ||
          document.documentElement.dataset.theme === "dark"
            ? "dark"
            : "light",
      }),
    );
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme"],
    });
    return () => {
      current = false;
      releasePreviewSlot(uid);
      preview.destroy();
      themeObserver.disconnect();
      connection.current = null;
      host.current = null;
      void controller
        .flush()
        .catch(() => {})
        .finally(() => controller.dispose());
    };
  }, [running, loaded, sessionId, revisionId, reference.title]);
  useEffect(() => {
    connection.current?.update();
  }, [height, width, expanded, tab, review]);
  useEffect(() => {
    if (!expanded) return;
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !review) setExpanded(false);
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [expanded, review]);
  async function download(format: "html" | "source") {
    setExporting(true);
    setError("");
    try {
      await artifactsApi.download(sessionId, revisionId, format);
    } catch (error) {
      if (alive.current) setError(errorText(error));
    } finally {
      if (alive.current) setExporting(false);
    }
  }
  async function confirmFeedback() {
    if (!review || sending) return;
    setSending(true);
    setError("");
    try {
      const result = await artifactsApi.feedback(sessionId, revisionId, review);
      if (!result.submitted)
        throw new Error("Feedback was not submitted. Retry to confirm.");
      if (alive.current) {
        setReview(null);
        setDraft({ text: "" });
        setNotice(translate("Feedback queued for the agent."));
      }
      // Server enqueues atomically. Never enqueue/send a second client message.
    } catch (error) {
      if (alive.current) setError(errorText(error));
    } finally {
      if (alive.current) setSending(false);
    }
  }
  async function start() {
    setError("");
    try {
      await acquirePreviewSlot(uid, pause);
      if (!alive.current) {
        releasePreviewSlot(uid);
        return;
      }
      setRunning(true);
    } catch (error) {
      setError(errorText(error));
    }
  }
  async function pause() {
    try {
      await host.current?.flush();
    } finally {
      connection.current?.destroy();
      releasePreviewSlot(uid);
      if (alive.current) {
        setRunning(false);
        setConnected(false);
      }
    }
  }
  useEffect(() => {
    if (
      !running ||
      !card.current ||
      typeof IntersectionObserver === "undefined"
    )
      return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0] && !entries[0].isIntersecting)
          void pause().catch((error) => setStateError(errorText(error)));
      },
      { rootMargin: "400px" },
    );
    observer.observe(card.current);
    const visibility = () => {
      if (document.hidden)
        void pause().catch((error) => setStateError(errorText(error)));
    };
    document.addEventListener("visibilitychange", visibility);
    return () => {
      observer.disconnect();
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [running]);
  function refresh() {
    setConnected(false);
    setRunning(false);
    setReload((value) => value + 1);
  }
  function reviewFeedback() {
    try {
      setReview({
        ...feedbackInput(draft, state, runtimeId()),
        ...(screenshot ? { screenshots: screenshotFeedback(screenshot) } : {}),
      });
    } catch (error) {
      setError(errorText(error));
    }
  }
  const revision = loaded?.bundle.revision;
  const ready = revision?.status === "ready";
  const versionItems = revisions.length
    ? revisions
    : [
        {
          revisionId: reference.revisionId,
          revisionNumber: 1,
          status: "ready",
        },
      ];
  return (
    <section
      ref={card}
      onPointerDownCapture={() => touchPreviewSlot(uid)}
      onFocusCapture={() => touchPreviewSlot(uid)}
      className={`artifact-card${expanded ? " artifact-card-expanded" : ""}`}
      aria-label={`Artifact: ${reference.title}`}
    >
      <header className="artifact-card-header">
        <div className="artifact-card-title">
          <span className="artifact-mark">
            <Code2 size={15} aria-hidden="true" />
          </span>
          <strong title={reference.title}>{reference.title}</strong>
          <span className="artifact-badge">
            {running
              ? connected
                ? translate("Live")
                : translate("Connecting")
              : revision?.status === "failed"
                ? translate("Build failed")
                : translate("Prototype")}
          </span>
        </div>
        <div className="artifact-header-actions">
          <select
            aria-label={translate("Artifact version")}
            value={revisionId}
            disabled={sending}
            onChange={(e) => {
              setRunning(false);
              setRevisionId(e.target.value);
              setCompareId("");
            }}
          >
            {versionItems.map((item) => (
              <option key={item.revisionId} value={item.revisionId}>
                v{item.revisionNumber}
                {item.status === "ready" ? "" : ` · ${item.status}`}
              </option>
            ))}
          </select>
          <button
            type="button"
            aria-label={
              expanded
                ? translate("Collapse artifact")
                : translate("Expand artifact")
            }
            title={expanded ? translate("Collapse") : translate("Expand")}
            onClick={() => setExpanded((value) => !value)}
          >
            {expanded ? <X size={15} /> : <Maximize2 size={15} />}
          </button>
        </div>
      </header>
      <div
        className="artifact-toolbar"
        aria-label={translate("Artifact actions")}
      >
        <div
          className="artifact-tabs"
          role="tablist"
          aria-label={translate("Artifact view")}
        >
          {(["preview", "source", "qa"] as const).map((item) => (
            <button
              key={item}
              type="button"
              role="tab"
              id={`${uid}-${item}`}
              aria-controls={`${uid}-${item}-panel`}
              aria-selected={tab === item}
              tabIndex={tab === item ? 0 : -1}
              onKeyDown={(event) => {
                const items = ["preview", "source", "qa"] as const;
                const index = items.indexOf(item);
                const next =
                  event.key === "ArrowRight"
                    ? items[(index + 1) % 3]
                    : event.key === "ArrowLeft"
                      ? items[(index + 2) % 3]
                      : event.key === "Home"
                        ? "preview"
                        : event.key === "End"
                          ? "qa"
                          : null;
                if (next) {
                  event.preventDefault();
                  setTab(next);
                  document.getElementById(`${uid}-${next}`)?.focus();
                }
              }}
              onClick={() => setTab(item)}
            >
              {item === "preview" ? (
                <Expand size={13} />
              ) : item === "source" ? (
                <Code2 size={13} />
              ) : (
                <FlaskConical size={13} />
              )}{" "}
              {translate(
                item === "qa" ? "QA" : item[0].toUpperCase() + item.slice(1),
              )}
            </button>
          ))}
        </div>
        <div className="artifact-run-actions">
          <button
            type="button"
            disabled={!ready || (!running && !!stateError)}
            onClick={() => (running ? void pause() : start())}
          >
            {running ? <Pause size={13} /> : <Play size={13} />}{" "}
            {running ? translate("Pause") : translate("Run")}
          </button>
          <button
            type="button"
            aria-label={translate("Reload saved state")}
            title={translate("Reload saved state")}
            onClick={refresh}
            disabled={sending}
          >
            <RotateCcw size={13} />
          </button>
        </div>
      </div>
      {error && (
        <div className="artifact-message artifact-error" role="alert">
          {error}
        </div>
      )}
      {stateError && (
        <div className="artifact-message artifact-error" role="alert">
          {stateError}
          <button type="button" onClick={refresh}>
            {translate("Reload saved state")}
          </button>
        </div>
      )}
      {notice && (
        <div className="artifact-message" role="status">
          {notice}
        </div>
      )}
      {!loaded && !error && (
        <div className="artifact-empty" role="status">
          {translate("Loading artifact and saved state…")}
        </div>
      )}
      {revision?.status === "failed" && (
        <div className="artifact-message artifact-error" role="alert">
          <strong>{translate("Build failed")}</strong>
          <pre>
            {revision.diagnostics.join("\n") ||
              translate("No build diagnostics were provided.")}
          </pre>
        </div>
      )}
      {revision?.status === "building" && (
        <div className="artifact-empty" role="status">
          {translate("This revision is still building.")}{" "}
          <button type="button" onClick={refresh}>
            {translate("Refresh")}
          </button>
        </div>
      )}
      <div
        id={`${uid}-preview-panel`}
        role="tabpanel"
        aria-labelledby={`${uid}-preview`}
        hidden={tab !== "preview"}
      >
        <div
          className="artifact-preview-stage"
          style={{
            height: expanded ? "min(65vh, 900px)" : height,
            width: width || "100%",
            maxWidth: "100%",
            marginInline: "auto",
            overflow: "hidden",
          }}
        >
          <div ref={container} className="artifact-preview-container" />
          {!desktop && (
            <ArtifactBoundsOverlay bounds={draft.element?.bounds ?? null} />
          )}
          {!running && ready && (
            <div className="artifact-empty artifact-run-prompt">
              <Code2 size={26} strokeWidth={1.4} />
              <strong>{translate("Interactive prototype")}</strong>
              <p>
                {desktop
                  ? translate("Run in a dedicated isolated desktop preview.")
                  : translate(
                      "Generated code runs in a sandboxed Web frame. Browser isolation cannot guarantee complete network or CPU isolation. Do not enter secrets.",
                    )}
              </p>
              <button
                type="button"
                className="artifact-primary"
                disabled={!!stateError}
                onClick={start}
              >
                <Play size={14} /> {translate("Run interactive content")}
              </button>
            </div>
          )}
          {running && !connected && (
            <div className="artifact-starting" role="status">
              {translate("Connecting preview…")}
            </div>
          )}
        </div>
        <div className="artifact-preview-footer">
          <span>
            {desktop
              ? translate("Dedicated desktop preview")
              : translate("Web sandbox · opt-in execution")}
          </span>
          <div className="artifact-dimensions">
            <label>
              {translate("Width")}{" "}
              <select
                aria-label={translate("Preview width")}
                value={width}
                onChange={(e) => setWidth(Number(e.target.value))}
              >
                <option value="0">{translate("Fill")}</option>
                {[300, 380, 520].map((size) => (
                  <option key={size} value={size}>
                    {size} px
                  </option>
                ))}
              </select>
            </label>
            <label>
              {translate("Height")}{" "}
              <select
                aria-label={translate("Preview height")}
                value={autoHeight ? "auto" : height}
                onChange={(e) => {
                  const auto = e.target.value === "auto";
                  setAutoHeight(auto);
                  autoHeightRef.current = auto;
                  if (!auto) setHeight(Number(e.target.value));
                }}
              >
                <option value="auto">
                  {locale === "zh" ? "自动" : "Auto"} ({height} px)
                </option>
                <option value="300">300 px</option>
                <option value="380">380 px</option>
                <option value="520">520 px</option>
              </select>
            </label>
          </div>
        </div>
      </div>
      {tab === "preview" && (
        <ArtifactCapture
          locale={locale}
          sessionId={sessionId}
          revisionId={revisionId}
          capture={
            desktop && connected ? connection.current?.capture : undefined
          }
          disabled={!running || !connected || sending}
          screenshot={screenshot}
          onChange={replaceScreenshot}
        />
      )}
      <VersionActions
        sessionId={sessionId}
        reference={revision ?? reference}
        onForkPublished={() =>
          setNotice(
            locale === "zh"
              ? "新分支已发布到会话"
              : "Branch published to conversation",
          )
        }
        onStateInherited={() => {
          setRunning(false);
          setReload((value) => value + 1);
        }}
      />
      {tab === "source" && (
        <ArtifactSourcePane
          uid={uid}
          locale={locale}
          sessionId={sessionId}
          revisionId={revisionId}
          revisions={revisions}
          compareId={compareId}
          reload={reload}
          onCompareChange={setCompareId}
        />
      )}
      {tab === "qa" && (
        <ArtifactQaPane
          uid={uid}
          locale={locale}
          controls={controls}
          values={state.controls}
          running={running}
          connected={connected}
          stateBlocked={!!stateError}
          sending={sending}
          draft={draft}
          logs={logs}
          reviewButton={reviewButton}
          onReset={() =>
            void host.current
              ?.reset()
              .catch((error) => setStateError(errorText(error)))
          }
          onControlChange={(control, value) =>
            void host.current
              ?.setControl(control, value)
              .catch((error) => setStateError(errorText(error)))
          }
          onPick={() => {
            setTab("preview");
            setPicking(true);
            connection.current?.send("pick", { enabled: true });
          }}
          onRemoveAnnotation={() => {
            setDraft((value) => ({ ...value, element: undefined }));
            void connection.current
              ?.annotate?.(null)
              .catch((error) => setError(errorText(error)));
          }}
          onTextChange={(text) => setDraft((value) => ({ ...value, text }))}
          onReview={reviewFeedback}
        />
      )}
      {picking && (
        <div className="artifact-message" role="status">
          {translate("Select an element inside the preview.")}
          <button
            type="button"
            onClick={() => {
              setPicking(false);
              connection.current?.send("pick", { enabled: false });
            }}
          >
            {translate("Cancel picking")}
          </button>
        </div>
      )}
      <footer className="artifact-card-footer">
        <span>
          {revision
            ? `v${revision.revisionNumber} · ${revision.sourceKind.toUpperCase()}`
            : translate("Artifact")}
          {savingState
            ? translate(" · Saving state…")
            : state.etag > 0
              ? translate(" · State saved")
              : ""}
        </span>
        <div>
          <button
            type="button"
            disabled={!ready || exporting}
            onClick={() => void download("html")}
          >
            <Download size={13} />{" "}
            {exporting ? translate("Exporting…") : "HTML"}
          </button>
          <button
            type="button"
            disabled={!loaded || exporting}
            onClick={() => void download("source")}
          >
            {translate("Source archive")}
          </button>
        </div>
      </footer>
      {review && (
        <ArtifactFeedbackConfirmation
          uid={uid}
          locale={locale}
          review={review}
          screenshotPreviews={screenshot ? [screenshot] : []}
          sending={sending}
          error={error}
          returnFocus={reviewButton}
          onCancel={() => setReview(null)}
          onConfirm={() => void confirmFeedback()}
        />
      )}
    </section>
  );
}
