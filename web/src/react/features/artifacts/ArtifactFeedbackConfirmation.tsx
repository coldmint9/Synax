import { useEffect, useRef, type RefObject } from "react";
import type { ArtifactFeedbackInput } from "../../../../../api/services/agent-runtime/artifacts/contracts";
import type { ArtifactScreenshot } from "./capture";
import { artifactText } from "./locale";
interface ArtifactFeedbackConfirmationProps {
  screenshotPreviews?: ArtifactScreenshot[];
  uid: string;
  locale: string;
  review: ArtifactFeedbackInput;
  sending: boolean;
  error: string;
  returnFocus: RefObject<HTMLButtonElement | null>;
  onCancel: () => void;
  onConfirm: () => void;
}
/** Presentation/focus only. The card owns the immutable review snapshot and POST. */
export function ArtifactFeedbackConfirmation({
  screenshotPreviews = [],
  uid,
  locale,
  review,
  sending,
  error,
  returnFocus,
  onCancel,
  onConfirm,
}: ArtifactFeedbackConfirmationProps) {
  const screenshots = review.screenshots ?? [];
  const missingPreview = screenshots.some(
    (s) =>
      !screenshotPreviews.some(
        (p) => p.assetId === s.assetId && p.previewConfirmed,
      ),
  );
  const translate = (text: string) => artifactText(locale, text);
  const confirmation = useRef<HTMLDivElement>(null);
  useEffect(() => {
    confirmation.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => returnFocus.current?.focus();
  }, [returnFocus]);
  return (
    <div className="artifact-dialog-backdrop" data-artifact-overlay="true">
      <div
        ref={confirmation}
        className="artifact-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${uid}-confirm-title`}
        onKeyDown={(e) => {
          if (e.key === "Escape" && !sending) {
            e.preventDefault();
            onCancel();
          }
          if (e.key === "Tab") {
            const buttons =
              confirmation.current?.querySelectorAll<HTMLButtonElement>(
                "button:not(:disabled)",
              );
            if (!buttons?.length) return;
            const first = buttons[0],
              last = buttons[buttons.length - 1];
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <h3 id={`${uid}-confirm-title`}>
          {translate("Send feedback to the agent?")}
        </h3>
        <p>
          {translate(
            "The server will queue this as your next input for this artifact revision.",
          )}
        </p>
        <pre>
          {JSON.stringify(
            {
              text: review.text,
              parameters: review.parameters,
              modelState: review.modelState,
              ...(review.element ? { element: review.element } : {}),
            },
            null,
            2,
          )}
        </pre>
        {screenshots.map((s) => {
          const preview = screenshotPreviews.find(
            (p) => p.assetId === s.assetId && p.previewConfirmed,
          );
          return preview ? (
            <figure key={s.assetId}>
              <img
                src={preview.previewUrl}
                alt={
                  locale === "zh"
                    ? "将发送给模型的截图"
                    : "Screenshot that will be sent to the model"
                }
                style={{ maxWidth: "100%", maxHeight: 240 }}
              />
              <figcaption>
                {locale === "zh"
                  ? "此截图将作为图像附件发送给模型。"
                  : "This screenshot will be sent to the model as an image attachment."}
              </figcaption>
            </figure>
          ) : null;
        })}
        {missingPreview && (
          <p role="alert">
            {locale === "zh"
              ? "截图预览不可用，请返回编辑并重新截图。"
              : "Screenshot preview unavailable. Return to editing and capture again."}
          </p>
        )}
        {error && <p role="alert">{error}</p>}
        <div className="artifact-dialog-actions">
          <button type="button" disabled={sending} onClick={() => onCancel()}>
            {translate("Keep editing")}
          </button>
          <button
            type="button"
            className="artifact-primary"
            disabled={sending || missingPreview}
            onClick={() => {
              if (!missingPreview) onConfirm();
            }}
          >
            {sending ? translate("Sending…") : translate("Confirm and send")}
          </button>
        </div>
      </div>
    </div>
  );
}
