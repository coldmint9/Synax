import postcss from "postcss";
import { describe, expect, it } from "vitest";
import css from "../composerEffortPicker.css?raw";

const stylesheet = postcss.parse(css);
function declarations(selector: string) {
  const result: Record<string, string> = {};
  stylesheet.walkRules(selector, (rule) => {
    rule.walkDecls((declaration) => {
      result[declaration.prop] = declaration.value;
    });
  });
  return result;
}

describe("effort picker theme", () => {
  it("uses Synax UI surfaces in both themes without a separate material palette", () => {
    expect(declarations(".composer-effort-rail").background).toBe(
      "var(--default)",
    );
    expect(declarations(".composer-effort-control")["--effort-ink"]).toBe("var(--accent)");
    expect(declarations(".composer-effort-thumb")["box-shadow"]).toBe(
      "var(--surface-shadow)",
    );
    expect(declarations(".dark .composer-effort-picker")).toEqual({});
  });

  it("retains a visible native slider focus and the approved rounded geometry", () => {
    expect(declarations(".composer-effort-range:focus-visible").outline).toBe("2px solid var(--focus)");
    expect(declarations('.composer-effort-picker[data-slot="popover"]').width).toBe("15rem");
    expect(declarations('.composer-effort-picker[data-slot="popover"]')["border-radius"]).toBe("16px");
    expect(declarations(".composer-effort-content").padding).toBe("12px");
    expect(declarations(".composer-effort-rail")["border-radius"]).toBe("28px");
    expect(declarations(".composer-effort-rail").height).toBe("56px");
    expect(declarations(".composer-effort-range").height).toBe("56px");
    expect(declarations(".composer-effort-thumb").width).toBe("32px");
    expect(declarations(".composer-effort-thumb")["border-radius"]).toBe("50%");
    expect(declarations(".composer-effort-title-text")["font-size"]).toBe("20px");
    expect(declarations(".composer-effort-title-track").height).toBe("68px");
    expect(declarations(".composer-effort-ascii").color).toBe("var(--effort-ink)");
  });

  it("disables max pulsing for reduced motion without hiding the ASCII title", () => {
    let reduced = false;
    stylesheet.walkAtRules("media", rule => {
      if (!rule.params.includes("prefers-reduced-motion: reduce")) return;
      rule.walkRules(".composer-effort-max-art", art => {
        art.walkDecls("animation", declaration => { reduced = declaration.value === "none"; });
      });
    });
    expect(reduced).toBe(true);
  });
});
