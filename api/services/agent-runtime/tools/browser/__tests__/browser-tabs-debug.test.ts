import { describe, expect, it } from "vitest";
import { BrowserSession } from "../browser-session.js";
import { fakeBrowser, fakePage } from "./browser-fakes.js";

describe("debug tabs", () => {
  it("traces", async () => {
    const pages = [fakePage({ url: "http://a.test/" }), fakePage({ url: "http://b.test/" })];
    const { browser } = fakeBrowser({ pages });
    const session = new BrowserSession({ sessionId: "d", launcher: async () => ({ browser, source: "fake" }) });
    const active = await session.resolvePage();
    console.log("active:", active.seq, JSON.stringify(session.tabs()));
    const first = await session.resolvePage({ pageSeq: 1 });
    console.log("first:", first.seq, JSON.stringify(session.tabs()));
    await session.closeTab(1);
    console.log("after close:", JSON.stringify(session.tabs()));
    expect(true).toBe(true);
  });
});
