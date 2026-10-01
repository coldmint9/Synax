import postcss from "postcss";
import { describe, expect, it } from "vitest";
import css from "../desktopPerformance.css?raw";
import commandDeckCss from "../design/command-deck.css?raw";
import glassCss from "../components/ui/glass/glass.css?raw";
import agentControlsCss from "../features/agent-workspace/agentControls.css?raw";
import appearanceCss from "../features/settings/components/appearance.css?raw";
import indexCss from "../../index.css?raw";

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
const web = indexRules(agentControlsCss);
const global = indexRules(indexCss);
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

function webValue(fragments: string[], property: string) {
  return findRule(web, fragments)?.declarations.get(property);
}

describe("desktop backdrop material parity", () => {
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

  it("restores the composer input shell material the Web build declares", () => {
    const fragments = [
      "html.electron",
      ".agent-session-controls",
      ".agent-session-composer-shell",
      ".agent-dock-shell",
    ];
    expect(
      webValue(
        [".agent-session-controls", ".agent-session-composer-shell"],
        "backdrop-filter",
      ),
    ).toBe("blur(5px)");
    expect(
      webValue(
        [".agent-session-controls", ".agent-session-composer-shell"],
        "background",
      ),
    ).toBe("hsl(0deg 0% 100% / 60%)");
    expect(desktopValue(fragments, "backdrop-filter")).toBe(
      "blur(5px) !important",
    );
    expect(desktopValue(fragments, "-webkit-backdrop-filter")).toBe(
      "blur(5px) !important",
    );
    // No opaque fill is forced here: agentControls.css keeps owning the Web
    // values hsl(0deg 0% 100% / 60%) (light) and hsl(0 0% 17% / 0.17) (dark).
    expect(desktopValue(fragments, "background")).toBeUndefined();
  });

  it("keeps the composer workspace / branch chips frosted", () => {
    // The Web chip material lives in index.css, not agentControls.css.
    expect(
      findRule(global, [".agent-dock-composer .agent-dock-composer-chip"])
        ?.declarations.get("backdrop-filter"),
    ).toBe("blur(8px)");
    for (const selector of [
      "html.electron .agent-dock-composer .agent-dock-composer-chip",
      "html.electron .agent-dock-composer .button--tertiary",
    ])
      expect(
        desktopValue([selector], "backdrop-filter"),
      ).toBe("blur(8px) !important");
  });

  it("mirrors the session file island pill declarations", () => {
    expect(indexCss).toContain("-webkit-backdrop-filter: blur(5px);");
    expect(desktopValue(
      ["html.electron", ".session-file-island-pill"],
      "-webkit-backdrop-filter",
    )).toBe("blur(5px) !important");
    // Chromium computes and paints the standard property, which the Web
    // stylesheet declares as blur(14px) in both themes.
    expect(indexCss).toContain("backdrop-filter: blur(14px);");
    expect(desktopValue(
      ["html.electron", ".session-file-island-pill"],
      "backdrop-filter",
    )).toBe("blur(14px) !important");
  });

  it("frosts the Work page branch and workspace pickers with the 5px glass", () => {
    const light = [
      "html.electron",
      ":is(.ws-branch-popover, .git-workspace-popover)",
    ];
    expect(desktopValue(light, "-webkit-backdrop-filter")).toBe(
      "blur(5px) !important",
    );
    expect(desktopValue(light, "backdrop-filter")).toBe("blur(5px) !important");
    expect(desktopValue(light, "background")).toBe(
      "hsl(0deg 0% 100% / 60%) !important",
    );
    expect(desktopValue(light, "background-image")).toBe("none !important");
    expect(
      desktopValue(
        [
          "html.electron.dark",
          ":is(.ws-branch-popover, .git-workspace-popover)",
        ],
        "background",
      ),
    ).toBe("hsl(0 0% 17% / 0.17) !important");
  });

  it("keeps the command island glass lens on desktop", () => {
    // Web sets the island blur radius in command-deck.css and paints it from
    // glass.css on the decorative backdrop layer.
    expect(commandDeckCss).toContain("--glass-blur: 8px;");
    expect(glassCss).toContain(
      "backdrop-filter: blur(var(--glass-blur)) saturate(1.15);",
    );
    const fragments = [
      "html.electron",
      ".synax-island-material.liquid-glass-surface[data-glass-state]",
      ".liquid-glass-backdrop",
    ];
    for (const property of ["backdrop-filter", "-webkit-backdrop-filter"])
      expect(desktopValue(fragments, property)).toBe(
        "blur(var(--glass-blur, 8px)) saturate(1.15) !important",
      );
  });

  it("scopes every blur declaration in the file to the electron shell", () => {
    const blurs: string[] = [];
    for (const rule of desktop) {
      for (const property of [
        "backdrop-filter",
        "-webkit-backdrop-filter",
      ]) {
        const value = rule.declarations.get(property);
        if (!value || value.startsWith("none")) continue;
        blurs.push(`${rule.selector} => ${value}`);
        expect(rule.selector).toContain("electron");
      }
    }
    expect(blurs.length).toBeGreaterThan(0);
  });
});
