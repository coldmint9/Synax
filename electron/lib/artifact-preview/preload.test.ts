import { readFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";
import { transpileModule } from "typescript";
import { describe, expect, it, vi } from "vitest";

describe("artifact preload boundaries", () => {
  it("exposes only fixed host transport methods and strips IPC events", async () => {
    const ipc = Object.assign(new EventEmitter(), {
      invoke: vi.fn(async () => {}),
      send: vi.fn(),
    });
    let api: any;
    runInNewContext(
      transpileModule(
        readFileSync(new URL("../../preload.ts", import.meta.url), "utf8"),
        {},
      ).outputText,
      {
        process: { platform: "darwin" },
        require: () => ({
          ipcRenderer: ipc,
          contextBridge: {
            exposeInMainWorld: (_name: string, value: unknown) => {
              api = value;
            },
          },
        }),
      },
    );
    expect(Object.keys(api.artifactPreview).sort()).toEqual([
      "create",
      "destroy",
      "onMessage",
      "send",
      "update",
    ]);
    const listener = vi.fn(),
      off = api.artifactPreview.onMessage(listener),
      message = { id: "one", message: { type: "hello" } };
    ipc.emit(
      "artifact-preview:message",
      { sender: "must not escape" },
      message,
    );
    expect(listener).toHaveBeenCalledExactlyOnceWith(message);
    off();
    expect(ipc.listenerCount("artifact-preview:message")).toBe(0);
    await api.artifactPreview.destroy("one");
    expect(ipc.invoke).toHaveBeenCalledWith("artifact-preview:destroy", "one");
  });
  it("exposes no artifact-world Electron API and only forwards bound directional envelopes", () => {
    const ipc = Object.assign(new EventEmitter(), { send: vi.fn() });
    const expose = vi.fn();
    let windowListener: (event: any) => void = () => {};
    const window = {
      addEventListener: (_type: string, listener: (event: any) => void) => {
        windowListener = listener;
      },
      postMessage: vi.fn(),
    };
    const binding = {
      id: "one",
      nonce: "n".repeat(32),
      prototypeId: "revision-one",
    };
    runInNewContext(
      transpileModule(
        readFileSync(
          new URL("../../artifact-preload.ts", import.meta.url),
          "utf8",
        ),
        {},
      ).outputText,
      {
        Buffer,
        window,
        process: {
          argv: [
            `--synax-artifact=${Buffer.from(JSON.stringify(binding)).toString("base64")}`,
          ],
        },
        require: () => ({
          ipcRenderer: ipc,
          contextBridge: { exposeInMainWorld: expose },
        }),
      },
    );
    const message = {
      protocol: 1,
      instanceId: "one",
      nonce: binding.nonce,
      prototypeId: binding.prototypeId,
      type: "hello",
    };
    windowListener({ source: {}, data: message });
    windowListener({ source: window, data: { ...message, nonce: "wrong" } });
    windowListener({
      source: window,
      data: { ...message, type: "executeJavaScript" },
    });
    for (const type of ["screenshot", "artifact-preview:capture"])
      windowListener({ source: window, data: { ...message, type } });
    expect(ipc.send).not.toHaveBeenCalled();
    expect(expose).not.toHaveBeenCalled();
    windowListener({ source: window, data: message });
    expect(ipc.send).toHaveBeenCalledExactlyOnceWith(
      "artifact-runtime:message",
      message,
    );
    ipc.emit("artifact-runtime:message", {}, { ...message, type: "connect" });
    expect(window.postMessage).toHaveBeenCalledExactlyOnceWith(
      { ...message, type: "connect" },
      "*",
    );
    windowListener({ source: window, data: { ...message, type: "connect" } });
    expect(ipc.send).toHaveBeenCalledTimes(1);
    windowListener({
      source: window,
      data: { ...message, type: "resize", payload: { height: 200 } },
    });
    expect(ipc.send).toHaveBeenLastCalledWith("artifact-runtime:message", {
      ...message,
      type: "resize",
      payload: { height: 200 },
    });
    ipc.emit("artifact-runtime:ping", {}, "challenge");
    expect(ipc.send).toHaveBeenLastCalledWith(
      "artifact-runtime:pong",
      "challenge",
    );
  });
});
