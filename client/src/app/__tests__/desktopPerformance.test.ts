import postcss from "postcss";
import { describe, expect, it } from "vitest";
import css from "../../shared/design/desktopPerformance.css?raw";
import appearanceCss from "../../features/settings/components/appearance.css?raw";

const normalize = (selector: string) => selector.replace(/\s+/g, " ").trim();

interface RuleInfo {
  selector: string;
  declarations: Map<string, string>;
}

function indexRules(source: string): RuleInfo[] {
  const sheet = postcss.parse(source);
  const rules: RuleInfo[] = [];
  sheet.walkRules((rule) => {
    const declarations = new Map<string, string>();
    rule.walkDecls((decl) => {
      declarations.set(
        decl.prop,
        decl.important ? `${decl.value} !important` : decl.value,
      );
    });
    rules.push({ selector: normalize(rule.selector), declarations });
  });
  return rules;
}

const desktop = indexRules(css);
const appearance = indexRules(appearanceCss);

/** First rule whose selector contains every fragment, mirroring how the
 *  browser resolves the most specific rule in each stylesheet. */
function findRule(rules: RuleInfo[], fragments: string[]) {
  return rules.find((rule) =>
    fragments.every((fragment) => rule.selector.includes(fragment)),
  );
}

function desktopValue(fragments: string[], property: string) {
  return findRule(desktop, fragments)?.declarations.get(property);
}

describe("desktop rendering budget", () => {
  it("reveals the native macOS surface when window material is enabled", () => {
    const transparent = findRule(appearance, [
      'html.electron-macos[data-mac-window-enabled="true"]',
      ":is(body",
      ".workbench-shell",
      ".workbench-island",
      ".work-page",
    ]);
    expect(transparent?.declarations.get("background")).toBe(
      "transparent !important",
    );
    expect(transparent?.declarations.get("background-image")).toBe(
      "none !important",
    );

    const viewport = findRule(appearance, [
      'html.electron-macos[data-mac-window-enabled="true"] .app-viewport',
    ]);
    expect(viewport?.declarations.get("background")).toBe(
      "hsl(var(--background-hsl) / var(--mac-window-opacity, 0.82)) !important",
    );
  });

  it("keeps the global performance opt-out for every unnamed surface", () => {
    const optOut = desktop[0];
    expect(optOut.selector).toContain("html.electron *");
    expect(optOut.declarations.get("backdrop-filter")).toBe("none !important");
    expect(optOut.declarations.get("-webkit-backdrop-filter")).toBe(
      "none !important",
    );

    const opaque = desktopValue(
      [".electron", ":is(", ".agent-dock-preview-pill"],
      "background",
    );
    expect(opaque).toBe("hsl(var(--card)) !important");
    const opaqueSelector =
      findRule(desktop, [".electron", ":is(", ".agent-dock-preview-pill"])
        ?.selector ?? "";
    for (const selector of [
      ".agent-dock-shell:not(.agent-session-composer-shell)",
      ".agent-dock-preview-pill",
      ".session-nav-preview",
      ".settings-section__body",
      ".ui-dialog-panel",
      ".popover",
    ])
      expect(opaqueSelector).toContain(selector);
    // The two named glass surfaces leave the forced-opaque list so the Web
    // translucent fills own them again.
    expect(opaqueSelector).not.toContain(".session-file-island-pill");
    expect(opaqueSelector).not.toContain(
      ":is(.agent-session-composer-shell",
    );
  });

  it("keeps persistent desktop surfaces opaque without forcing compositor hints off", () => {
    expect(desktopValue(["html.electron", ".agent-session-composer-shell", ".session-file-island-pill"], "background"))
      .toBe("var(--surface) !important");
    for (const rule of desktop) {
      expect(rule.declarations.get("will-change")).not.toBe("auto !important");
      for (const property of ["backdrop-filter", "-webkit-backdrop-filter"]) {
        const value = rule.declarations.get(property);
        if (value) expect(value).toBe("none !important");
      }
    }
  });
  it("pauses motion on invisible or disconnected pages while keeping text readable", () => {
    expect(desktopValue(['html[data-runtime-motion="paused"]'], "animation-play-state")).toBe("paused !important");
    const text = findRule(desktop, [".bui-thinking-label", ".bui-activity-brief"]);
    expect(text?.declarations.get("animation")).toBe("none !important");
    expect(text?.declarations.get("color")).toBe("var(--foreground) !important");
  });
});
