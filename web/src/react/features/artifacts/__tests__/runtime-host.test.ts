import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactRuntimeHost } from "../runtime-host";
import { artifactsApi } from "../../../../lib/api/artifacts";
vi.mock("../../../../lib/api/artifacts", () => ({
  artifactsApi: { saveState: vi.fn() },
}));
const state = {
  privateState: { secret: "never send" },
  modelState: null,
  controls: {},
  schemaVersion: 1,
  etag: 3,
};
function makeHost() {
  const options = {
    sessionId: "s",
    revisionId: "r",
    state,
    onState: vi.fn(),
    onControls: vi.fn(),
    onDraft: vi.fn(),
    onHeight: vi.fn(),
    onError: vi.fn(),
    send: vi.fn(),
  };
  return { host: new ArtifactRuntimeHost(options), options };
}
beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.mocked(artifactsApi.saveState).mockImplementation(
    async (_s, _r, value) => ({ ...value, etag: value.etag + 1 }),
  );
});
afterEach(() => vi.useRealTimers());
describe("artifact runtime host", () => {
  it("debounces and saves revision-bound state with etag CAS", async () => {
    const { host } = makeHost();
    const one = host.handle("state", { modelState: { page: 1 } });
    const two = host.handle("state", { modelState: { page: 2 } });
    expect(artifactsApi.saveState).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(500);
    await Promise.all([one, two]);
    expect(artifactsApi.saveState).toHaveBeenCalledTimes(1);
    expect(artifactsApi.saveState).toHaveBeenCalledWith("s", "r", {
      ...state,
      modelState: { page: 2 },
    });
    expect(host.state.etag).toBe(4);
    host.dispose();
  });
  it("freezes conflicting state instead of retrying with a newer etag", async () => {
    const { host, options } = makeHost();
    vi.mocked(artifactsApi.saveState).mockRejectedValue(
      new Error("STATE_CONFLICT"),
    );
    const save = host.handle("state", { modelState: { page: 1 } });
    const rejected = expect(save).rejects.toThrow("STATE_CONFLICT");
    await vi.advanceTimersByTimeAsync(500);
    await rejected;
    await expect(host.handle("state", { modelState: 2 })).rejects.toThrow(
      "not writable",
    );
    expect(options.onError).toHaveBeenCalledWith(
      expect.stringContaining("Reload saved state"),
    );
    expect(artifactsApi.saveState).toHaveBeenCalledTimes(1);
    host.dispose();
  });
  it("draft and element requests never save state or submit feedback", async () => {
    const { host, options } = makeHost();
    await host.handle("feedbackDraft", {
      text: "fix",
      privateState: "injected",
    });
    expect(options.onDraft).toHaveBeenCalledWith({
      text: "fix",
      modelState: null,
    });
    await host.handle("element", {
      tag: "button",
      text: "Continue",
      qaId: "continue",
    });
    expect(options.onDraft).toHaveBeenLastCalledWith({
      element: { tag: "button", text: "Continue", qaId: "continue" },
    });
    expect(artifactsApi.saveState).not.toHaveBeenCalled();
    host.dispose();
  });
  it("rejects privileged requests and clamps heights", async () => {
    const { host, options } = makeHost();
    await expect(host.handle("executeShell", { cmd: "ls" })).rejects.toThrow(
      "Unsupported",
    );
    await expect(
      host.handle("state", { controls: { admin: true } }),
    ).rejects.toThrow("Only");
    await expect(
      host.handle("state", { modelState: "x".repeat(17000) }),
    ).rejects.toThrow("exceeds");
    await host.handle("resize", { height: 100000 });
    expect(options.onHeight).toHaveBeenCalledWith(640);
    host.dispose();
  });
  it("serializes overlapping writes using the etag returned by the first write", async () => {
    const { host } = makeHost();
    let resolve!: Function;
    vi.mocked(artifactsApi.saveState).mockImplementationOnce(
      () =>
        new Promise((r) => {
          resolve = r;
        }),
    );
    const first = host.handle("state", { modelState: 1 });
    void host.flush();
    const second = host.handle("state", { modelState: 2 });
    resolve({ ...state, modelState: 1, etag: 4 });
    await host.flush();
    await Promise.all([first, second]);
    expect(artifactsApi.saveState).toHaveBeenLastCalledWith("s", "r", {
      ...state,
      modelState: 2,
      etag: 4,
    });
    host.dispose();
  });
});
