import { beforeEach, describe, expect, it, vi } from "vitest";
import { resetBrowserSessionsForTests } from "../browser-manager.js";

const mocks = vi.hoisted(() => ({ launch: vi.fn() }));

vi.mock("playwright-core", () => ({
  chromium: {
    launch: mocks.launch,
    executablePath: () => "/nonexistent/chromium",
  },
}));

vi.mock("../../../session-store.js", () => ({
  agentRuntimeStore: {
    getSession: (sessionId: string) => ({ id: sessionId, projectId: "proj_1" }),
  },
}));

vi.mock("../../../media-assets.js", () => ({
  createAsset: async (_projectId: string, filename: string, bytes: Buffer) => ({
    id: "asset_abc",
    filename,
    mediaType: "image/jpeg",
    size: bytes.length,
  }),
}));

const { browserTools } = await import("../browser-tools.js");

function tool(id: string) {
  const found = browserTools.find((candidate) => candidate.id === id);
  if (!found) throw new Error(`Tool not registered: ${id}`);
  return found;
}

function exec(id: string) {
  return tool(id).execute;
}

const baseInput = (sessionId: string) => ({
  sessionId,
  runId: null,
  stepId: null,
  toolCallId: `tc_${sessionId}`,
  toolId: "browser.navigate",
  category: "read" as const,
  mutability: "read" as const,
  args: {},
});

beforeEach(async () => {
  const { fakeBrowser } = await import("./browser-fakes.js");
  mocks.launch.mockImplementation(async () => {
    const { browser } = fakeBrowser();
    return browser;
  });
  mocks.launch.mockClear();
  resetBrowserSessionsForTests();
});

describe("browser tools", () => {
  it("block non-http URLs before launching a browser", async () => {
    await expect(
      exec("browser.navigate")(baseInput("s1")),
    ).rejects.toThrow(/Provide a URL/);
    await expect(
      exec("browser.navigate")({ ...baseInput("s1"), args: { url: "file:///etc/passwd" } }),
    ).rejects.toThrow(/file:\/\/ is blocked|Only http/i);
    expect(mocks.launch).not.toHaveBeenCalled();
  });

  it("navigate launches lazily and returns a snapshot with refs and tabs", async () => {
    const result = await exec("browser.navigate")({
      ...baseInput("s2"),
      args: { url: "http://localhost:3000/" },
    });
    expect(mocks.launch).toHaveBeenCalledTimes(1);
    const payload = result.result as Record<string, any>;
    expect(payload.url).toBe("http://localhost:3000/");
    expect(payload.title).toBe("Test Page");
    expect(payload.snapshot).toContain('[ref=e5]');
    expect(payload.tabs).toHaveLength(1);
    expect(payload.hint).toContain("browser.click");
  });

  it("reuse one browser across calls within the same session", async () => {
    await exec("browser.navigate")({ ...baseInput("s3"), args: { url: "http://localhost:3000/a" } });
    await exec("browser.snapshot")(baseInput("s3"));
    expect(mocks.launch).toHaveBeenCalledTimes(1);
  });

  it("click acts on the aria-ref locator and re-snapshots", async () => {
    await exec("browser.navigate")({ ...baseInput("s4"), args: { url: "http://localhost:3000/form" } });
    const result = await exec("browser.click")({ ...baseInput("s4"), args: { ref: "e5" } });
    const payload = result.result as Record<string, any>;
    expect(payload.clicked).toBe("e5");
    expect(payload.snapshot).toContain("[ref=e5]");
  });

  it("stale refs surface a re-snapshot hint instead of a raw timeout", async () => {
    await exec("browser.navigate")({ ...baseInput("s5"), args: { url: "http://localhost:3000/form" } });
    await expect(
      exec("browser.click")({ ...baseInput("s5"), args: { ref: "e999" } }),
    ).rejects.toThrow(/browser\.snapshot again/);
  });

  it("type fills and optionally submits", async () => {
    await exec("browser.navigate")({ ...baseInput("s6"), args: { url: "http://localhost:3000/search" } });
    const result = await exec("browser.type")({
      ...baseInput("s6"),
      args: { ref: "e5", text: "synax", submit: true },
    });
    expect((result.result as Record<string, any>).submit).toBe(true);
  });

  it("console captures console messages and page errors with filters", async () => {
    await exec("browser.navigate")({ ...baseInput("s7"), args: { url: "http://localhost:3000/" } });
    const { fakePage } = await import("./browser-fakes.js");
    const session = (await import("../browser-manager.js")).getBrowserSession("s7")!;
    // Re-emit through the wired page listeners.
    const page = (session as any).pages.get(1).page;
    page.emit("console", { type: () => "error", text: () => "boom" });
    page.emit("pageerror", new Error("uncaught"));
    const all = await exec("browser.console")(baseInput("s7"));
    expect((all.result as any).entries.map((entry: any) => entry.level)).toEqual([
      "error",
      "pageerror",
    ]);
    const errorsOnly = await exec("browser.console")({
      ...baseInput("s7"),
      args: { kind: "pageerror" },
    });
    expect((errorsOnly.result as any).entries).toHaveLength(1);
  });

  it("network lists captured traffic and returns a body by seq", async () => {
    await exec("browser.navigate")({ ...baseInput("s8"), args: { url: "http://localhost:3000/" } });
    const session = (await import("../browser-manager.js")).getBrowserSession("s8")!;
    const page = (session as any).pages.get(1).page;
    const { fakeResponse } = await import("./browser-fakes.js");
    page.emit("response", fakeResponse({ url: "http://localhost:3000/api/tasks", body: '{"ok":false}' }));
    const listed = await exec("browser.network")({
      ...baseInput("s8"),
      args: { filter: "/api/" },
    });
    const entries = (listed.result as any).entries;
    expect(entries).toHaveLength(1);
    expect(entries[0].status).toBe(200);
    const body = await exec("browser.network")({
      ...baseInput("s8"),
      args: { seq: entries[0].seq },
    });
    expect((body.result as any).body.text).toBe('{"ok":false}');
  });

  it("evaluate returns the serialized page result", async () => {
    await exec("browser.navigate")({ ...baseInput("s9"), args: { url: "http://localhost:3000/" } });
    const result = await exec("browser.evaluate")({
      ...baseInput("s9"),
      args: { expression: "document.title" },
    });
    expect((result.result as any).value).toBe('"evaluated"');
  });

  it("screenshot attaches an image asset", async () => {
    await exec("browser.navigate")({ ...baseInput("s10"), args: { url: "http://localhost:3000/" } });
    const result = await exec("browser.screenshot")({
      ...baseInput("s10"),
      args: { filename: "home page!" },
    });
    expect(result.contentParts).toEqual([{ type: "image", assetId: "asset_abc" }]);
    expect((result.result as any).asset.filename).toBe("home-page.jpg");
  });

  it("close disposes the session browser", async () => {
    await exec("browser.navigate")({ ...baseInput("s11"), args: { url: "http://localhost:3000/" } });
    const manager = await import("../browser-manager.js");
    expect(manager.getBrowserSession("s11")).toBeDefined();
    await exec("browser.close")(baseInput("s11"));
    expect(manager.getBrowserSession("s11")).toBeUndefined();
  });

  it("rejects malformed refs at the schema level", () => {
    expect(() =>
      tool("browser.click").inputSchema!.parse({ ref: "div.button" }),
    ).toThrow();
    expect(() =>
      tool("browser.click").inputSchema!.parse({ ref: "f1e3" }),
    ).not.toThrow();
  });
});
