import {
  fireEvent,
  render,
  screen,
  waitFor,
  cleanup,
} from "@testing-library/react";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { ArtifactCapture, ArtifactBoundsOverlay } from "../ArtifactCapture";
import {
  screenshotBlob,
  screenshotFeedback,
  type ArtifactCaptureResult,
} from "../capture";
import { ArtifactFeedbackConfirmation } from "../ArtifactFeedbackConfirmation";
import { apiFetch } from "../../../../lib/api/origin";
vi.mock("../../../../lib/api/origin", () => ({ apiFetch: vi.fn() }));
const assetId = "asset_" + "a".repeat(32);
function image(): ArtifactCaptureResult {
  const bytes = Uint8Array.from(
    atob(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9ZlWQAAAAASUVORK5CYII=",
    ),
    (c) => c.charCodeAt(0),
  );
  return {
    id: "instance",
    revisionId: "revision",
    mimeType: "image/png",
    bytes,
    width: 1,
    height: 1,
  };
}
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal(
    "URL",
    class extends URL {
      static createObjectURL = vi.fn(() => "blob:screenshot");
      static revokeObjectURL = vi.fn();
    },
  );
  vi.mocked(apiFetch).mockResolvedValue(
    Response.json({ asset: { id: assetId } }),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("does not auto-capture/upload; requires host click and explicit image preview confirmation", async () => {
  const capture = vi.fn(async () => image()),
    onChange = vi.fn();
  render(
    <ArtifactCapture
      locale="en"
      sessionId="session"
      revisionId="revision"
      capture={capture}
      screenshot={null}
      onChange={onChange}
    />,
  );
  expect(capture).not.toHaveBeenCalled();
  expect(apiFetch).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Capture prototype"));
  await screen.findByAltText("Screenshot preview awaiting confirmation");
  expect(apiFetch).not.toHaveBeenCalled();
  expect(onChange).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText("Confirm screenshot attachment"));
  await waitFor(() =>
    expect(onChange).toHaveBeenCalledWith({
      assetId,
      previewConfirmed: true,
      previewUrl: "blob:screenshot",
    }),
  );
  const [url, init] = vi.mocked(apiFetch).mock.calls[0];
  expect(url).toContain(
    "/sessions/session/artifacts/revisions/revision/screenshots",
  );
  expect(init?.headers).toEqual({
    "X-Synax-Artifact-Action": "capture-screenshot",
  });
  expect(init?.body).toBeInstanceOf(FormData);
  expect((init?.body as FormData).get("file")).toBeInstanceOf(File);
  expect(screenshotFeedback(onChange.mock.calls[0][0])).toEqual([
    { assetId, previewConfirmed: true },
  ]);
});
it("clearly reports unavailable Web capability without fake screenshot", () => {
  render(
    <ArtifactCapture
      locale="en"
      sessionId="s"
      revisionId="revision"
      screenshot={null}
      onChange={vi.fn()}
    />,
  );
  expect(screen.getByText("Capture prototype")).toBeDisabled();
  expect(screen.getByRole("status")).toHaveTextContent("unavailable");
  expect(screen.queryByRole("img")).toBeNull();
});
it("drops captures after revision switch and revokes discarded previews", async () => {
  let finish!: (image: ArtifactCaptureResult) => void;
  const capture = vi.fn(
    () =>
      new Promise<ArtifactCaptureResult>((resolve) => {
        finish = resolve;
      }),
  );
  const props = {
    locale: "en",
    sessionId: "s",
    revisionId: "revision",
    screenshot: null,
    onChange: vi.fn(),
    capture,
  };
  const view = render(<ArtifactCapture {...props} />);
  fireEvent.click(screen.getByText("Capture prototype"));
  view.rerender(<ArtifactCapture {...props} revisionId="next" />);
  finish(image());
  await waitFor(() => expect(screen.queryByRole("img")).toBeNull());
  expect(URL.createObjectURL).not.toHaveBeenCalled();
  view.rerender(<ArtifactCapture {...props} capture={async () => image()} />);
  fireEvent.click(screen.getByText("Capture prototype"));
  await screen.findByAltText("Screenshot preview awaiting confirmation");
  fireEvent.click(screen.getByText("Discard screenshot"));
  expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:screenshot");
});
it("rejects wrong revision, excessive bytes and dimensions", () => {
  expect(() => screenshotBlob(image(), "other")).toThrow();
  expect(() =>
    screenshotBlob(
      { ...image(), bytes: new Uint8Array(4 * 1024 * 1024 + 1) },
      "revision",
    ),
  ).toThrow();
  const large = image();
  new DataView(large.bytes.buffer).setUint32(16, 4097);
  expect(() => screenshotBlob(large, "revision")).toThrow();
});
it("draws a pointer-transparent bounded host annotation; rejects malformed bounds", () => {
  const view = render(
    <ArtifactBoundsOverlay
      bounds={{
        x: 10,
        y: 20,
        width: 30,
        height: 40,
        viewportWidth: 100,
        viewportHeight: 100,
      }}
    />,
  );
  const overlay = view.container.querySelector(
    "[data-artifact-annotation]",
  ) as HTMLElement;
  expect(overlay.style.left).toBe("10%");
  expect(overlay.style.pointerEvents).toBe("none");
  view.rerender(
    <ArtifactBoundsOverlay
      bounds={{
        x: 100,
        y: 0,
        width: 50,
        height: 10,
        viewportWidth: 100,
        viewportHeight: 100,
      }}
    />,
  );
  expect(view.container.firstChild).toBeNull();
});
it("final feedback confirmation shows exact attachment and blocks absent screenshot preview", () => {
  const review = {
    text: "Fix",
    idempotencyKey: "key",
    screenshots: [{ assetId, previewConfirmed: true as const }],
  };
  const props = {
    uid: "test",
    locale: "en",
    review,
    sending: false,
    error: "",
    returnFocus: { current: null },
    onCancel: vi.fn(),
    onConfirm: vi.fn(),
  };
  const view = render(<ArtifactFeedbackConfirmation {...props} />);
  expect(screen.getByText("Confirm and send")).toBeDisabled();
  view.rerender(
    <ArtifactFeedbackConfirmation
      {...props}
      screenshotPreviews={[
        { assetId, previewConfirmed: true, previewUrl: "blob:review" },
      ]}
    />,
  );
  expect(
    screen.getByAltText("Screenshot that will be sent to the model"),
  ).toHaveAttribute("src", "blob:review");
  expect(screen.getByText("Confirm and send")).not.toBeDisabled();
});
