import { beforeEach, describe, expect, it } from "vitest";
import {
  getProjectThemeColor,
  resetProjectThemeColors,
} from "./projectThemeColor";

describe("projectThemeColor", () => {
  beforeEach(() => {
    resetProjectThemeColors();
  });

  it("keeps a project color stable for the page lifetime", () => {
    expect(getProjectThemeColor("api")).toBe(getProjectThemeColor("api"));
  });

  it("returns the default color for an unknown project", () => {
    expect(getProjectThemeColor()).toBe("default");
    expect(getProjectThemeColor("  ")).toBe("default");
  });

  it("assigns different colors before the palette is exhausted", () => {
    const colors = new Set(
      ["api", "web", "docs"].map((projectId) =>
        getProjectThemeColor(projectId),
      ),
    );
    expect(colors.size).toBe(3);
    expect(colors.has("default")).toBe(false);
  });
});
