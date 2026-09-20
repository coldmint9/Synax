import { describe, expect, it } from "vitest";
import { wikiRoutes } from "../wiki.js";

describe("shared prompt endpoint purpose boundary", () => {
  const build = (
    mode: string,
    path = "/projects/prompt-fixture/session-prompt",
  ) =>
    wikiRoutes.request(`http://localhost${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        mode,
        content: "请调查认证",
        wikiAttachMode: "manual",
        locale: "zh",
      }),
    });
  it("returns original user intent for general sessions", async () => {
    const response = await build("session");
    expect(response.status).toBe(200);
    const data = (await response.json()) as {
      prompt: string;
      wikiContext: unknown;
    };
    expect(data.prompt).toBe("请调查认证");
    expect(data.wikiContext).toMatchObject({
      documentId: null,
      mode: "manual",
    });
  });
  it("preserves the explicit Wiki direct workflow protocol", async () => {
    const response = await build("direct");
    expect(response.status).toBe(200);
    const data = (await response.json()) as { prompt: string };
    expect(data.prompt).toContain("implement the goal");
    expect(data.prompt).toContain("## User Goal");
  });
  it("rejects unknown initialization purposes", async () => {
    expect((await build("arbitrary-purpose")).status).toBe(400);
  });
  it.each(["session", "direct", "plan_node"])(
    "keeps legacy clients compatible for %s prompts",
    async (mode) => {
      const canonical = await build(mode);
      const legacy = await build(
        mode,
        "/projects/prompt-fixture/goals/session-prompt",
      );
      expect(legacy.status).toBe(canonical.status);
      expect(await legacy.json()).toEqual(await canonical.json());
    },
  );
});
