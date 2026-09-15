import { describe, expect, it, vi } from "vitest";
const fixture = vi.hoisted(() => ({
  scan: { scanId: "stable-scan", text: "auth module" },
  wiki: "Architecture summary",
}));
vi.mock("../../../../db/index.js", () => ({
  getRawSqlite: () => ({
    prepare: (sql: string) => ({
      get: () =>
        sql.includes("wiki_scan_git_cache")
          ? { resultJson: JSON.stringify(fixture.scan) }
          : { title: "Landscape", contentMd: fixture.wiki },
    }),
  }),
}));
vi.mock("../agent-code-map-context.js", () => ({
  buildAgentCodeMapContext: (scan: { text: string }) => scan.text,
}));
import { enrichContextForPrompt } from "../synax-runtime-context.js";
import { buildLoopSystemPrompt } from "../../loop-prompt.js";
import { synaxAgentProfile } from "../synax-agent-profile.js";

it("re-enriches Code Map/Wiki with fresh storage IDs but stable model-visible content", () => {
  const contexts = Array.from({ length: 3 }, () =>
    enrichContextForPrompt(null, "project", "/workspace", "Investigate auth"),
  );
  expect(new Set(contexts.map((context) => context!.blocks[0].id)).size).toBe(
    3,
  );
  const prompt = (context: (typeof contexts)[number]) =>
    buildLoopSystemPrompt({
      profile: synaxAgentProfile,
      context,
      history: [],
      previousParts: [],
      previousToolCalls: [],
      currentPrompt: "Investigate auth",
      maxSteps: 10,
      stepIndex: 1,
    });
  expect(new Set(contexts.map(prompt)).size).toBe(1);
  fixture.wiki = "Updated architecture summary";
  expect(
    prompt(
      enrichContextForPrompt(null, "project", "/workspace", "Investigate auth"),
    ),
  ).not.toBe(prompt(contexts[0]));
});
