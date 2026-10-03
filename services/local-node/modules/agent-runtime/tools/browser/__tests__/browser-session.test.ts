import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  acquireBrowserSession,
  closeAllBrowserSessions,
  closeBrowserSession,
  getBrowserSession,
  resetBrowserSessionsForTests,
} from "../browser-manager.js";
import {
  BrowserSession,
  RingBuffer,
  validateHttpUrl,
} from "../browser-session.js";
import {
  defaultHeadless,
  launchTargets,
  browserInstallError,
} from "../browser-launch.js";
import { fakeBrowser, fakePage } from "./browser-fakes.js";

describe("RingBuffer", () => {
  it("caps at capacity, dropping oldest", () => {
    const buffer = new RingBuffer<number>(3);
    for (const value of [1, 2, 3, 4, 5]) buffer.push(value);
    expect(buffer.items).toEqual([3, 4, 5]);
    expect(buffer.length).toBe(3);
  });
});

describe("URL validation", () => {
  it("allows http(s) and localhost", () => {
    expect(validateHttpUrl("http://localhost:5173/app").protocol).toBe("http:");
    expect(validateHttpUrl("https://example.com/x?y=1").hostname).toBe("example.com");
  });
  it("rejects other schemes and garbage", () => {
    expect(() => validateHttpUrl("file:///etc/passwd")).toThrow(/Only http/);
    expect(() => validateHttpUrl("javascript:alert(1)")).toThrow(/Only http/);
    expect(() => validateHttpUrl("not a url")).toThrow(/not a valid URL/);
  });
});

describe("BrowserSession", () => {
  it("validates playwright ref format", () => {
    expect(BrowserSession.isValidRef("e12")).toBe(true);
    expect(BrowserSession.isValidRef("f1e5")).toBe(true);
    expect(BrowserSession.isValidRef("button")).toBe(false);
    expect(BrowserSession.isValidRef("")).toBe(false);
  });

  it("reuses a single browser across pages and disposes once", async () => {
    const { browser } = fakeBrowser();
    const launcher = async () => ({ browser, source: "fake" });
    const session = new BrowserSession({ sessionId: "s", launcher });
    await session.ensureLaunched();
    await session.ensureLaunched();
    expect((browser as any).newContext).toHaveBeenCalledTimes(1);
    await session.dispose("test");
    await session.dispose("test again");
    expect((browser as any).close).toHaveBeenCalledTimes(1);
    expect(session.disposed).toBe(true);
    await expect(session.ensureLaunched()).rejects.toThrow(/was closed/);
  });

  it("tracks tabs and switches the active one", async () => {
    const { browser } = fakeBrowser();
    const session = new BrowserSession({ sessionId: "tabs", launcher: async () => ({ browser, source: "fake" }) });
    const firstTab = await session.resolvePage();
    expect(firstTab.seq).toBe(1);
    const secondTab = await session.resolvePage({ newTab: true });
    expect(secondTab.seq).toBe(2);
    // The most recently opened page is the active one.
    expect(session.tabs().find((tab) => tab.active)?.seq).toBe(2);
    expect(session.describeTabs()).toContain("tab 2*:");
    const switched = await session.resolvePage({ pageSeq: 1 });
    expect(switched.seq).toBe(1);
    expect(session.tabs().find((tab) => tab.active)?.seq).toBe(1);
    await session.closeTab(1);
    expect(session.tabs().find((tab) => tab.active)?.seq).toBe(2);
    await expect(session.closeTab(1)).rejects.toThrow(/not open/);
    await session.dispose("test");
  });

  it("rebuilds after the browser disconnects", async () => {
    const first = fakeBrowser();
    let current = first;
    const session = new BrowserSession({
      sessionId: "reconnect",
      launcher: async () => ({ browser: current.browser, source: "fake" }),
    });
    await session.ensureLaunched();
    (first.browser as any).emit("disconnected");
    const second = fakeBrowser();
    current = second;
    await session.ensureLaunched();
    expect((second.browser as any).close).not.toHaveBeenCalled();
    await session.dispose("test");
  });
});

describe("browser manager", () => {
  beforeEach(() => resetBrowserSessionsForTests());
  afterEach(async () => {
    await closeAllBrowserSessions("test end");
  });

  function launcherFor(sessionId: string) {
    const { browser } = fakeBrowser();
    void sessionId;
    return async () => ({ browser, source: "fake" });
  }

  it("returns the same session instance while alive", async () => {
    const a = await acquireBrowserSession({ sessionId: "m1", launcher: launcherFor("m1") });
    const b = await acquireBrowserSession({ sessionId: "m1", launcher: launcherFor("m1") });
    expect(b).toBe(a);
    expect(getBrowserSession("m1")).toBe(a);
  });

  it("evicts the most idle session beyond the concurrency cap", async () => {
    const ids = ["c1", "c2", "c3", "c4"];
    for (const id of ids)
      await acquireBrowserSession({ sessionId: id, launcher: launcherFor(id) });
    for (const id of ids) expect(getBrowserSession(id)).toBeDefined();
    const fifth = await acquireBrowserSession({ sessionId: "c5", launcher: launcherFor("c5") });
    expect(getBrowserSession("c5")).toBe(fifth);
    const alive = ids.filter((id) => getBrowserSession(id));
    expect(alive.length).toBeLessThanOrEqual(4);
  });

  it("closeBrowserSession is a no-op for unknown sessions", async () => {
    await expect(closeBrowserSession("ghost", "test")).resolves.toBeUndefined();
  });
});

describe("browser launch", () => {
  const OLD_ENV = process.env;

  beforeEach(() => {
    process.env = { ...OLD_ENV };
    delete process.env.SYNAX_BROWSER_PATH;
    delete process.env.SYNAX_BROWSER_HEADLESS;
  });
  afterEach(() => {
    process.env = OLD_ENV;
  });

  it("defaults to headless unless explicitly disabled", () => {
    expect(defaultHeadless()).toBe(true);
    process.env.SYNAX_BROWSER_HEADLESS = "0";
    expect(defaultHeadless()).toBe(false);
    process.env.SYNAX_BROWSER_HEADLESS = "no";
    expect(defaultHeadless()).toBe(false);
  });

  it("puts the env-configured executable first and rejects missing paths", () => {
    process.env.SYNAX_BROWSER_PATH = "/definitely/not/here";
    expect(() => launchTargets(true)).toThrow(/SYNAX_BROWSER_PATH/);
  });

  it("orders targets: env path, managed chromium, channels, system scan", () => {
    process.env.SYNAX_BROWSER_PATH = "/tmp";
    const targets = launchTargets(true);
    expect(targets[0].options.executablePath).toBe("/tmp");
    const sources = targets.map((target) => target.source);
    expect(sources).toContain("system chrome");
    expect(sources).toContain("system msedge");
    for (const target of targets) expect(target.options.headless).toBe(true);
  });

  it("explains how to install a browser when every launch fails", () => {
    const error = browserInstallError(["system chrome: boom"]);
    expect(error.message).toContain("npx playwright install chromium");
    expect(error.message).toContain("SYNAX_BROWSER_PATH");
    expect(error.message).toContain("system chrome: boom");
  });
});
