import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "../../../../..");
const css = readFileSync(
  resolve(root, "src/react/features/agent-workspace/newSessionWelcome.css"),
  "utf8",
);

describe("new-session offline typography", () => {
  it("ships both unmodified font weights and their redistribution license", () => {
    for (const weight of ["Regular", "Bold"]) {
      const font = readFileSync(
        resolve(root, `src/assets/fonts/LiberationMono-${weight}.ttf`),
      );
      expect(font.readUInt32BE(0)).toBe(0x00010000);
      expect(font.byteLength).toBeGreaterThan(100_000);
      expect(css).toContain(`LiberationMono-${weight}.ttf`);
    }
    expect(
      existsSync(resolve(root, "public/licenses/liberation-mono/NOTICE.txt")),
    ).toBe(true);
    expect(
      readFileSync(
        resolve(root, "public/licenses/liberation-mono/LICENSE.txt"),
        "utf8",
      ),
    ).toContain("SIL OPEN FONT LICENSE");
    expect(css).not.toMatch(/url\(["']?https?:/);
  });

  it("does not put a generic monospace fallback before Chinese heading fonts", () => {
    const titleRule = css.split(".session-welcome-title {")[1].split("}")[0];
    expect(titleRule).toContain('"PingFang SC"');
    expect(titleRule).not.toContain("var(--session-font-mono)");
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain("justify-content: safe center");
  });
});
