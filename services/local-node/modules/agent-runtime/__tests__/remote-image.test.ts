import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { IncomingMessage, RequestOptions } from "node:http";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ lookup: vi.fn(), request: vi.fn() }));
vi.mock("node:dns/promises", () => ({ lookup: mocks.lookup }));
vi.mock("node:http", () => ({ default: { request: mocks.request } }));
vi.mock("node:https", () => ({ default: { request: mocks.request } }));
import { fetchRemoteImage } from "../file-input/remote-image.js";

const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
type Reply = {
  status?: number;
  headers?: Record<string, string | undefined>;
  chunks?: Buffer[];
  stall?: boolean;
  abort?: boolean;
  networkError?: boolean;
};
let replies: Reply[];
let streams: PassThrough[];
let signals: AbortSignal[];

beforeEach(() => {
  mocks.lookup.mockReset().mockResolvedValue([{ address: "93.184.216.34", family: 4 }]);
  replies = [];
  streams = [];
  signals = [];
  mocks.request.mockReset().mockImplementation((
    _url: URL, options: RequestOptions, callback: (response: IncomingMessage) => void,
  ) => {
    const reply = replies.shift() ?? {};
    const response = Object.assign(new PassThrough(), {
      statusCode: reply.status ?? 200,
      headers: reply.headers ?? { "content-type": "image/png" },
      complete: !reply.abort,
    });
    streams.push(response);
    const request = Object.assign(new EventEmitter(), {
      destroy: vi.fn((): void => {
        options.signal?.removeEventListener("abort", onAbort);
        response.destroy();
      }),
      end: vi.fn(() => {
        queueMicrotask(() => {
          if (reply.networkError) { request.emit("error", new Error("network failed")); return; }
          callback(response as unknown as IncomingMessage);
          if (response.destroyed) return;
          for (const chunk of reply.chunks ?? [png]) response.write(chunk);
          if (reply.abort) { response.emit("aborted"); response.destroy(); }
          else if (!reply.stall) response.end();
        });
      }),
    });
    const onAbort = () => {
      request.destroy();
      request.emit("error", options.signal?.reason ?? new Error("aborted"));
    };
    if (options.signal) {
      signals.push(options.signal);
      options.signal.addEventListener("abort", onAbort, { once: true });
    }
    return request;
  });
});
afterEach(() => { vi.useRealTimers(); });

const fetchImage = (url = "https://images.example/picture.png", limit = 1024) => fetchRemoteImage(url, limit);

describe("fetchRemoteImage", () => {
  it("pins the validated address, preserves the HTTPS hostname and disables connection reuse", async () => {
    const result = await fetchImage();
    expect(result).toEqual({ bytes: png, filename: "picture.png", mediaType: "image/png" });
    const [url, options] = mocks.request.mock.calls[0];
    expect(url.hostname).toBe("images.example");
    expect(options.agent).toBe(false);
    const callback = vi.fn();
    options.lookup("images.example", {}, callback);
    expect(callback).toHaveBeenLastCalledWith(null, "93.184.216.34", 4);
    options.lookup("images.example", { all: true }, callback);
    expect(callback).toHaveBeenLastCalledWith(null, [{ address: "93.184.216.34", family: 4 }]);
    expect(mocks.lookup).toHaveBeenCalledTimes(1);
  });

  it.each([
    "file:///tmp/image.png", "ftp://images.example/a", "https://user:secret@images.example/a",
    "http://localhost/a", "http://a.localhost./a", "http://127.1/a", "http://2130706433/a",
    "http://0.0.0.0/a", "http://10.1.2.3/a", "http://100.64.0.1/a",
    "http://169.254.169.254/a", "http://172.16.0.1/a", "http://192.168.0.1/a",
    "http://192.0.2.1/a", "http://198.18.0.1/a", "http://224.0.0.1/a", "http://255.255.255.255/a",
    "http://[::1]/a", "http://[::]/a", "http://[::ffff:127.0.0.1]/a",
    "http://[::ffff:8.8.8.8]/a", "http://[fc00::1]/a", "http://[fe80::1]/a",
    "http://[2001:db8::1]/a", "http://[2002:7f00:1::]/a", "http://[64:ff9b::7f00:1]/a",
  ])("rejects unsafe URL %s before any connection", async (url) => {
    await expect(fetchImage(url)).rejects.toThrow();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("rejects mixed public/private DNS results", async () => {
    mocks.lookup.mockResolvedValue([{ address: "8.8.8.8", family: 4 }, { address: "::ffff:10.0.0.1", family: 6 }]);
    await expect(fetchImage()).rejects.toThrow("private or reserved");
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("accepts public IPv6 literals without DNS", async () => {
    await expect(fetchImage("https://[2606:4700:4700::1111]/image.png")).resolves.toMatchObject({ mediaType: "image/png" });
    expect(mocks.lookup).not.toHaveBeenCalled();
  });

  it("handles DNS failure and empty answers", async () => {
    mocks.lookup.mockRejectedValueOnce(new Error("DNS failed")).mockResolvedValueOnce([]);
    await expect(fetchImage()).rejects.toThrow("DNS failed");
    await expect(fetchImage()).rejects.toThrow("no addresses");
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("validates every redirect including relative locations", async () => {
    replies.push({ status: 302, headers: { location: "/next.png" } });
    mocks.lookup.mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }])
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    await expect(fetchImage()).rejects.toThrow("private or reserved");
    expect(mocks.lookup).toHaveBeenCalledTimes(2);
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it.each(["http://169.254.169.254/a", "https://user:pass@images.example/a", "file:///etc/passwd"])("blocks redirect to %s", async (location) => {
    replies.push({ status: 307, headers: { location } });
    await expect(fetchImage()).rejects.toThrow();
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it("revalidates DNS on same-host redirects and blocks changed private answers", async () => {
    mocks.lookup
      .mockResolvedValueOnce([{ address: "8.8.8.8", family: 4 }])
      .mockResolvedValueOnce([{ address: "127.0.0.1", family: 4 }]);
    replies.push({ status: 302, headers: { location: "/next.png" } });
    await expect(fetchImage()).rejects.toThrow("private or reserved");
    expect(mocks.lookup).toHaveBeenCalledTimes(2);
    expect(mocks.request).toHaveBeenCalledTimes(1);
  });

  it("allows five redirects and rejects the sixth", async () => {
    replies.push(...Array.from({ length: 5 }, () => ({ status: 302, headers: { location: "../ok.png" } })));
    await expect(fetchImage()).resolves.toMatchObject({ filename: "ok.png" });
    expect(mocks.request).toHaveBeenCalledTimes(6);
    mocks.request.mockClear();
    replies.push(...Array.from({ length: 6 }, () => ({ status: 302, headers: { location: "/again" } })));
    await expect(fetchImage()).rejects.toThrow("redirect limit");
    expect(mocks.request).toHaveBeenCalledTimes(6);
  });

  it.each([404, 500, 304])("rejects HTTP %s", async (status) => {
    replies.push({ status });
    await expect(fetchImage()).rejects.toThrow("HTTP status");
    expect(streams[0].destroyed).toBe(true);
  });
  it("rejects a redirect without Location", async () => {
    replies.push({ status: 301 });
    await expect(fetchImage()).rejects.toThrow("no Location");
  });

  it("enforces both declared and streamed size and accepts the exact limit", async () => {
    replies.push({ headers: { "content-type": "image/png", "content-length": "999999" } });
    await expect(fetchImage()).rejects.toThrow("byte limit");
    replies.push({ chunks: [png, Buffer.alloc(1)] });
    await expect(fetchImage(undefined, 8)).rejects.toThrow("byte limit");
    expect(streams[1].destroyed).toBe(true);
    await expect(fetchImage(undefined, 8)).resolves.toMatchObject({ bytes: png });
  });
  it.each([0, -1, Infinity, NaN, 1.5])("rejects invalid limit %s", async (limit) => {
    await expect(fetchImage(undefined, limit)).rejects.toThrow("byte limit");
    expect(mocks.lookup).not.toHaveBeenCalled();
  });

  it.each([
    { headers: { "content-type": "text/html" }, chunks: [png] },
    { headers: {}, chunks: [png] },
    { headers: { "content-type": "image/unknown" }, chunks: [png] },
    { headers: { "content-type": "image/jpeg" }, chunks: [png] },
    { headers: { "content-type": "image/png" }, chunks: [Buffer.from("<html>not an image</html>")] },
    { headers: { "content-type": "image/svg+xml" }, chunks: [Buffer.from("<html><svg></svg></html>")] },
    { headers: { "content-type": "image/png", "content-encoding": "gzip" }, chunks: [png] },
  ])("rejects invalid MIME, fake images and encoded bodies: %j", async (reply) => {
    replies.push(reply);
    await expect(fetchImage()).rejects.toThrow();
  });

  it.each([
    ["image/png", png],
    ["image/jpeg", Buffer.from([255, 216, 255, 224])],
    ["image/gif", Buffer.from("GIF89a")],
    ["image/webp", Buffer.from("RIFF0000WEBP")],
    ["image/bmp", Buffer.concat([Buffer.from("BM"), Buffer.alloc(24)])],
    ["image/avif", Buffer.from([0, 0, 0, 20, ...Buffer.from("ftypmif1"), 0, 0, 0, 0, ...Buffer.from("avif")])],
    ["image/svg+xml", Buffer.from('<?xml version="1.0"?><!-- image --><svg xmlns="http://www.w3.org/2000/svg"></svg>')],
  ] as const)("returns bytes for %s", async (mediaType, bytes) => {
    replies.push({ headers: { "content-type": `${mediaType}; charset=utf-8` }, chunks: [bytes] });
    await expect(fetchImage()).resolves.toMatchObject({ mediaType, bytes });
  });

  it("propagates network and interrupted body errors", async () => {
    replies.push({ networkError: true }, { abort: true });
    await expect(fetchImage()).rejects.toThrow("network failed");
    await expect(fetchImage()).rejects.toThrow("aborted");
  });

  it("bounds DNS time and never connects after late DNS completion", async () => {
    vi.useFakeTimers();
    let complete!: (value: { address: string; family: number }[]) => void;
    mocks.lookup.mockImplementation(() => new Promise((resolve) => { complete = resolve; }));
    const assertion = expect(fetchImage()).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(15000);
    await assertion;
    complete([{ address: "8.8.8.8", family: 4 }]);
    await Promise.resolve();
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("uses one deadline across DNS, redirects and stalled response bodies", async () => {
    vi.useFakeTimers();
    mocks.lookup.mockImplementation(() => new Promise((resolve) => {
      setTimeout(() => resolve([{ address: "8.8.8.8", family: 4 }]), 4000);
    }));
    replies.push({ status: 302, headers: { location: "/next" } }, { stall: true });
    const assertion = expect(fetchImage()).rejects.toThrow("timed out");
    await vi.advanceTimersByTimeAsync(14999);
    expect(mocks.request).toHaveBeenCalledTimes(2);
    expect(signals[1].aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await assertion;
    expect(signals[1].aborted).toBe(true);
    expect(streams[1].destroyed).toBe(true);
  });
});
