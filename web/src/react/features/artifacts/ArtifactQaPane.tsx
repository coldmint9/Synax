import type { RefObject } from "react";
import { ArtifactCapture, type ArtifactCaptureProps } from "./ArtifactCapture";
import { X } from "lucide-react";
import type {
  ArtifactControl,
  ArtifactState,
} from "../../../../../api/services/agent-runtime/artifacts/contracts";
import type { FeedbackDraft } from "./bridge";
import { ArtifactControls } from "./ArtifactControls";
import { artifactText } from "./locale";
interface ArtifactQaPaneProps {
  captureProps?: ArtifactCaptureProps;
  uid: string;
  locale: string;
  controls: ArtifactControl[];
  values: ArtifactState["controls"];
  running: boolean;
  connected: boolean;
  stateBlocked: boolean;
  sending: boolean;
  draft: FeedbackDraft;
  logs: Array<{ level: string; message: string }>;
  reviewButton: RefObject<HTMLButtonElement | null>;
  onReset: () => void;
  onControlChange: (control: ArtifactControl, value: unknown) => void;
  onPick: () => void;
  onRemoveAnnotation: () => void;
  onTextChange: (text: string) => void;
  onReview: () => void;
}
export function ArtifactQaPane({
  captureProps,
  uid,
  locale,
  controls,
  values,
  running,
  connected,
  stateBlocked,
  sending,
  draft,
  logs,
  reviewButton,
  onReset,
  onControlChange,
  onPick,
  onRemoveAnnotation,
  onTextChange,
  onReview,
}: ArtifactQaPaneProps) {
  const translate = (text: string) => artifactText(locale, text);
  return (
    <div
      className="artifact-qa"
      role="tabpanel"
      id={`${uid}-qa-panel`}
      aria-labelledby={`${uid}-qa`}
    >
      <div className="artifact-section-heading">
        <strong>{translate("Parameters")}</strong>
        <button
          type="button"
          disabled={!connected || stateBlocked}
          onClick={onReset}
        >
          {translate("Reset state")}
        </button>
      </div>
      {controls.length ? (
        <ArtifactControls
          controls={controls}
          values={values}
          disabled={!connected || stateBlocked}
          onChange={onControlChange}
        />
      ) : (
        <p className="artifact-muted">
          {running
            ? translate("This prototype has not registered any controls.")
            : translate("Run the prototype to load its controls.")}
        </p>
      )}
      <div className="artifact-section-heading">
        <strong>{translate("Feedback")}</strong>
        <button type="button" disabled={!connected} onClick={onPick}>
          {translate("Pick an element")}
        </button>
      </div>
      {draft.element && (
        <div className="artifact-annotation">
          <code>
            {draft.element.qaId
              ? `[data-qa-id="${draft.element.qaId}"]`
              : draft.element.tag}
          </code>
          <span>{draft.element.text}</span>
          <button
            type="button"
            aria-label={translate("Remove annotation")}
            onClick={onRemoveAnnotation}
          >
            <X size={13} />
          </button>
        </div>
      )}
      {captureProps && <ArtifactCapture {...captureProps} />}
      <label className="artifact-feedback-label" htmlFor={`${uid}-feedback`}>
        {translate("What should change?")}
      </label>
      <textarea
        id={`${uid}-feedback`}
        rows={4}
        maxLength={8000}
        value={draft.text ?? ""}
        onChange={(e) => onTextChange(e.target.value)}
        placeholder={translate(
          "Describe the change you want the agent to make…",
        )}
      />
      <p className="artifact-muted">
        {locale === "zh"
          ? "仅发送你的说明、参数、模型可见状态、选中元素及已确认的截图。私有状态不会包含在反馈中。"
          : "Only your note, parameters, model-visible state, selected element and confirmed screenshot are sent. Private state stays out of feedback."}
      </p>
      <button
        ref={reviewButton}
        type="button"
        className="artifact-primary"
        disabled={!draft.text?.trim() || sending}
        onClick={onReview}
      >
        {translate("Review feedback")}
      </button>
      {!!logs.length && (
        <details className="artifact-logs">
          <summary>
            {locale === "zh" ? "运行诊断" : "Runtime diagnostics"} (
            {logs.length}/100)
          </summary>
          <pre>
            {logs
              .map((entry) => `[${entry.level}] ${entry.message}`)
              .join("\n")}
          </pre>
        </details>
      )}
    </div>
  );
}
