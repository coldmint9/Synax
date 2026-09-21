import { afterEach, describe, expect, it, vi } from "vitest";
import vm from "node:vm";
import { artifactSdkSource } from "../../../../../../api/services/agent-runtime/artifacts/runtime-sdk";
function runtime(config: any = null) {
  const posted: any[] = [];
  const events = new Map<string, Function>();
  const meta = { getAttribute: () => JSON.stringify(config), remove: vi.fn() };
  const context: any = {
    console: { ...console },
    TextEncoder,
    setTimeout,
    clearTimeout,
    navigator: { language: "en" },
    MessagePort: class {},
    Element: class {},
    document: {
      querySelector: () => meta,
      documentElement: {
        dataset: {},
        style: { setProperty: vi.fn() },
        scrollHeight: 400,
      },
      readyState: "loading",
      addEventListener: vi.fn(),
    },
  };
  context.window = {
    postMessage: (message: any) => posted.push(message),
    parent: { postMessage: (message: any) => posted.push(message) },
    addEventListener: (type: string, fn: Function) => events.set(type, fn),
    removeEventListener: () => {},
    matchMedia: () => ({ matches: false }),
  };
  vm.createContext(context);
  vm.runInContext(artifactSdkSource(), context);
  return { context, api: context.window.synaxWidget, posted, events, meta };
}
afterEach(() => vi.useRealTimers());
describe("static artifact SDK", () => {
  it("runs emitted bootstrap without imports, transpiler helpers or Node globals", async () => {
    const { api, context } = runtime();
    expect(await api.ready()).toMatchObject({
      standalone: true,
      theme: "light",
    });
    await vm.runInContext(
      'window.synaxWidget.setState({privateState:{count:2},modelState:{screen:"home"}})',
      context,
    );
    expect(api.getState().privateState).toEqual({ count: 2 });
    await expect(
      vm.runInContext(
        'window.synaxWidget.requestFeedbackDraft({text:"no host"})',
        context,
      ),
    ).rejects.toThrow("standalone");
    expect(Object.keys(api).sort()).toEqual(
      [
        "getState",
        "onControlsChange",
        "onStateChange",
        "onThemeChange",
        "ready",
        "registerControls",
        "reportHeight",
        "requestFeedbackDraft",
        "setState",
      ].sort(),
    );
  });
  it("requires matching host source and credentials before using transferred port", async () => {
    vi.useFakeTimers();
    const config = {
      protocol: 1,
      instanceId: "i",
      nonce: "n",
      revisionId: "r",
      transport: "web",
    };
    const { context, api, events, posted, meta } = runtime(config);
    expect(meta.remove).toHaveBeenCalled();
    expect(posted[0]).toMatchObject({ ...config, type: "hello" });
    const port = {
      postMessage: vi.fn(),
      start: vi.fn(),
      onmessage: null as any,
    };
    const connect = vm.runInContext(
      `(${JSON.stringify({ ...config, type: "connect" })})`,
      context,
    );
    events.get("message")!({ source: {}, data: connect, ports: [port] });
    events.get("message")!({
      source: context.window.parent,
      data: { ...connect, nonce: "stale" },
      ports: [port],
    });
    expect(port.start).not.toHaveBeenCalled();
    events.get("message")!({
      source: context.window.parent,
      data: connect,
      ports: [port],
    });
    const ready = api.ready();
    await Promise.resolve();
    await Promise.resolve();
    const request = port.postMessage.mock.calls[0][0];
    expect(request.type).toBe("ready");
    const initial = vm.runInContext(
      '({theme:"dark",locale:"en",state:{privateState:null,modelState:null,controls:{},schemaVersion:1,etag:0}})',
      context,
    );
    const response = vm.runInContext(
      `(${JSON.stringify({ ...config, type: "response", requestId: request.requestId, payload: { result: initial } })})`,
      context,
    );
    port.onmessage({ data: response });
    expect((await ready).theme).toBe("dark");
  });
  it("rejects calls after handshake timeout instead of silently treating hosted code as standalone", async () => {
    vi.useFakeTimers();
    const { api } = runtime({
      protocol: 1,
      instanceId: "i",
      nonce: "n",
      revisionId: "r",
    });
    const ready = api.ready();
    const assertion = expect(ready).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
  });
});
