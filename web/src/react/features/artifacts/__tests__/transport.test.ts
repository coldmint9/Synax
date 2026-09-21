import { afterEach, describe, expect, it, vi } from "vitest";
import { mountPreview } from "../transport";
function setup() {
  const container = document.createElement("div");
  document.body.append(container);
  const options = {
    container,
    html: "<html><head></head><body>Preview</body></html>",
    revisionId: "r",
    title: "Demo",
    onRequest: vi.fn(),
    onConnected: vi.fn(),
    onError: vi.fn(),
  };
  return { container, options };
}
afterEach(() => {
  delete (window as any).electronAPI;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});
describe("artifact transport", () => {
  it("creates only an opaque sandbox with no privileged permissions", () => {
    const { container, options } = setup();
    const transport = mountPreview(options);
    const frame = container.querySelector("iframe")!;
    expect(frame.getAttribute("sandbox")).toBe("allow-scripts");
    expect(frame.referrerPolicy).toBe("no-referrer");
    expect(frame.srcdoc).toContain("synax-artifact-runtime");
    transport.destroy();
    expect(container.querySelector("iframe")).toBeNull();
  });
  it("rejects same envelope from the wrong window", () => {
    const { container, options } = setup();
    const transport = mountPreview(options);
    const frame = container.querySelector("iframe")!;
    const doc = new DOMParser().parseFromString(frame.srcdoc, "text/html");
    const config = JSON.parse(
      doc.querySelector("meta")!.getAttribute("content")!,
    );
    window.dispatchEvent(
      new MessageEvent("message", {
        source: window,
        data: { ...config, type: "hello" },
      }),
    );
    expect(options.onConnected).not.toHaveBeenCalled();
    transport.destroy();
  });
  it("does not fall back when the desktop bridge is missing", async () => {
    (window as any).electronAPI = {};
    const { container, options } = setup();
    const transport = mountPreview(options);
    await Promise.resolve();
    expect(options.onError).toHaveBeenCalledWith(
      expect.objectContaining({
        message: expect.stringContaining("No Web fallback"),
      }),
    );
    expect(container.querySelector("iframe")).toBeNull();
    transport.destroy();
  });
  it("does not fall back when a dedicated view fails, and cleans up late subscription", async () => {
    const unsubscribe = vi.fn();
    const api = {
      create: vi.fn().mockRejectedValue(new Error("view crashed")),
      update: vi.fn().mockResolvedValue(undefined),
      send: vi.fn().mockResolvedValue(undefined),
      destroy: vi.fn().mockResolvedValue(undefined),
      onMessage: vi.fn().mockResolvedValue(unsubscribe),
    };
    (window as any).electronAPI = { artifactPreview: api };
    const { container, options } = setup();
    const transport = mountPreview(options);
    await vi.waitFor(() => expect(options.onError).toHaveBeenCalled());
    expect(container.querySelector("iframe")).toBeNull();
    expect(unsubscribe).toHaveBeenCalled();
    expect(api.destroy).toHaveBeenCalled();
    transport.destroy();
  });
});
it("repositions a desktop view when its owner window requests fresh layout", async () => {
  let notify: (event: any) => void = () => {};
  const api = {
    create: vi.fn().mockResolvedValue(undefined),
    update: vi.fn().mockResolvedValue(undefined),
    send: vi.fn().mockResolvedValue(undefined),
    destroy: vi.fn().mockResolvedValue(undefined),
    onMessage: vi.fn((listener: any) => {
      notify = listener;
      return () => {};
    }),
  };
  (window as any).electronAPI = { artifactPreview: api };
  const { options } = setup();
  const preview = mountPreview(options);
  await vi.waitFor(() => expect(api.create).toHaveBeenCalledOnce());
  const input = api.create.mock.calls[0][0];
  await vi.waitFor(() => expect(api.update).toHaveBeenCalled());
  const previous = api.update.mock.calls.length;
  notify({
    id: input.id,
    message: {
      protocol: 1,
      instanceId: input.id,
      nonce: input.nonce,
      revisionId: input.revisionId,
      type: "transport-needs-layout",
    },
  });
  await vi.waitFor(() =>
    expect(api.update.mock.calls.length).toBeGreaterThan(previous),
  );
  preview.destroy();
});
