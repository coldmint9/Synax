import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
const css = readFileSync(
  resolve(import.meta.dirname, "../composerModes.css"),
  "utf8",
);
const welcome = readFileSync(
  resolve(import.meta.dirname, "../newSessionWelcome.css"),
  "utf8",
);
describe("composer mode borders", () => {
  it("keeps the quiet goal cue and removes plan-mode styling", () => {
    expect(css).not.toContain('[data-composer-mode="plan"]');
    expect(css).toContain('[data-composer-mode="goal"]');
    expect(css).toContain("border: 1px solid var(--ui-line)");
    expect(css).toContain("border-inline-start: 2px solid color-mix");
  });
  it("has no chat-mode tint and removes the old centered green focus override", () => {
    expect(css).not.toContain('[data-composer-mode="chat"]');
    expect(welcome).not.toContain("#72b4a1");
    expect(css).toContain("forced-colors: active");
  });
});
