import { useEffect, useRef, useState } from "react";
import {
  screenshotBlob,
  uploadArtifactScreenshot,
  validElementBounds,
  type ArtifactCaptureResult,
  type ArtifactElementBounds,
  type ArtifactScreenshot,
} from "./capture";

export interface ArtifactCaptureProps {
  locale: string;
  sessionId: string;
  revisionId: string;
  capture?: () => Promise<ArtifactCaptureResult>;
  disabled?: boolean;
  screenshot: ArtifactScreenshot | null;
  /** Parent owns attached preview URL lifetime; revoke on removal/revision change/unmount. */
  onChange: (screenshot: ArtifactScreenshot | null) => void;
}
/** Capture is triggered by this trusted host button only, never by a runtime message. */
export function ArtifactCapture({
  locale,
  sessionId,
  revisionId,
  capture,
  disabled,
  screenshot,
  onChange,
}: ArtifactCaptureProps) {
  const zh = locale === "zh";
  const [pending, setPending] = useState<{
    image: ArtifactCaptureResult;
    url: string;
  } | null>(null);
  const [busy, setBusy] = useState(false);
  const [cooldown, setCooldown] = useState(false);
  const cooldownTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [error, setError] = useState("");
  const generation = useRef(0),
    pendingUrl = useRef<string | null>(null);
  const inFlight = useRef(false);
  useEffect(() => {
    generation.current++;
    setPending(null);
    setBusy(false);
    setCooldown(false);
    setError("");
    inFlight.current = false;
    return () => {
      generation.current++;
      if (cooldownTimer.current) clearTimeout(cooldownTimer.current);
      if (pendingUrl.current) URL.revokeObjectURL(pendingUrl.current);
      pendingUrl.current = null;
    };
  }, [sessionId, revisionId]);
  const discard = () => {
    if (pendingUrl.current) URL.revokeObjectURL(pendingUrl.current);
    pendingUrl.current = null;
    setPending(null);
  };
  async function take() {
    if (!capture || disabled || inFlight.current || cooldown || pending) return;
    const epoch = generation.current;
    inFlight.current = true;
    setBusy(true);
    setCooldown(true);
    if (cooldownTimer.current) clearTimeout(cooldownTimer.current);
    cooldownTimer.current = setTimeout(() => {
      if (epoch === generation.current) setCooldown(false);
    }, 1000);
    setError("");
    try {
      const image = await capture();
      if (epoch !== generation.current) return;
      const blob = screenshotBlob(image, revisionId);
      discard();
      const url = URL.createObjectURL(blob);
      pendingUrl.current = url;
      setPending({ image, url });
    } catch (e) {
      if (epoch === generation.current)
        setError(e instanceof Error ? e.message : "Screenshot failed.");
    } finally {
      if (epoch === generation.current) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }
  async function attach() {
    if (!pending || disabled || inFlight.current) return;
    const epoch = generation.current;
    inFlight.current = true;
    setBusy(true);
    setError("");
    try {
      const { assetId } = await uploadArtifactScreenshot(
        sessionId,
        revisionId,
        pending.image,
      );
      if (epoch !== generation.current) return;
      onChange({ assetId, previewConfirmed: true, previewUrl: pending.url });
      pendingUrl.current = null;
      setPending(null);
    } catch (e) {
      if (epoch === generation.current)
        setError(e instanceof Error ? e.message : "Screenshot upload failed.");
    } finally {
      if (epoch === generation.current) {
        inFlight.current = false;
        setBusy(false);
      }
    }
  }
  return (
    <section
      className="artifact-capture"
      style={{ position: "relative" }}
      aria-label={zh ? "原型截图" : "Prototype screenshot"}
    >
      <button
        type="button"
        onClick={() => void take()}
        disabled={!capture || disabled || busy || cooldown || !!pending}
      >
        {zh ? "截取原型" : "Capture prototype"}
      </button>
      {!capture && (
        <p role="status">
          {zh
            ? "当前预览不支持截图。网页模式不会生成模拟截图。"
            : "Screenshot capture is unavailable in this preview. Web previews do not generate simulated screenshots."}
        </p>
      )}
      {pending && (
        <div data-artifact-overlay="true">
          <img
            src={pending.url}
            alt={
              zh
                ? "待确认的原型截图"
                : "Screenshot preview awaiting confirmation"
            }
            style={{ maxWidth: "100%", maxHeight: 240 }}
          />
          <p>
            {zh
              ? "请检查截图内容，确认后将上传并随反馈发送给模型。"
              : "Review this image before uploading and sharing it with the model as feedback."}
          </p>
          <button
            type="button"
            disabled={busy || disabled}
            onClick={() => void attach()}
          >
            {zh ? "确认附加此截图" : "Confirm screenshot attachment"}
          </button>
          <button type="button" disabled={busy} onClick={discard}>
            {zh ? "丢弃截图" : "Discard screenshot"}
          </button>
        </div>
      )}
      {screenshot && (
        <div>
          <img
            src={screenshot.previewUrl}
            alt={zh ? "已确认的截图附件" : "Confirmed screenshot attachment"}
            style={{ maxWidth: "100%", maxHeight: 160 }}
          />
          <button
            type="button"
            disabled={busy || disabled}
            onClick={() => onChange(null)}
          >
            {zh ? "移除截图" : "Remove screenshot"}
          </button>
        </div>
      )}
      {busy && (
        <p role="status">{zh ? "正在处理截图…" : "Processing screenshot…"}</p>
      )}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
/** Use only above Web iframe inside a position:relative, overflow:hidden preview host.
 * Desktop uses the manager's explicitly clipped native strips instead. */
export function ArtifactBoundsOverlay({
  bounds,
}: {
  bounds: ArtifactElementBounds | null;
}) {
  if (!bounds || !validElementBounds(bounds)) return null;
  return (
    <div
      aria-hidden="true"
      data-artifact-annotation="true"
      style={{
        position: "absolute",
        pointerEvents: "none",
        boxSizing: "border-box",
        border: "2px solid #2563eb",
        left: `${(bounds.x / bounds.viewportWidth) * 100}%`,
        top: `${(bounds.y / bounds.viewportHeight) * 100}%`,
        width: `${(bounds.width / bounds.viewportWidth) * 100}%`,
        height: `${(bounds.height / bounds.viewportHeight) * 100}%`,
      }}
    />
  );
}
