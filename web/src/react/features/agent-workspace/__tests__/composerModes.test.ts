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
  it("uses a thick blue dashed plan border and a purple solid goal border", () => {
    expect(css).toMatch(
      /\[data-composer-mode="plan"\]\s*\{\s*--composer-mode-border: #2563eb;/,
    );
    expect(css).toMatch(
      /\[data-composer-mode="goal"\]\s*\{\s*--composer-mode-border: #8b5cf6;/,
    );
    expect(css).toMatch(
      /:root\s+\.agent-session-controls\[data-composer-mode="plan"\]\s*\.agent-session-composer-shell.agent-dock-shell\s*\{\s*border: 2px dashed var\(--composer-mode-border\);/,
    );
    expect(css).toContain("border: 2px solid var(--composer-mode-border)");
  });
  it("has no chat-mode tint and removes the old centered green focus override", () => {
    expect(css).not.toContain('[data-composer-mode="chat"]');
    expect(welcome).not.toContain("#72b4a1");
    expect(css).toContain("forced-colors: active");
  });
});
