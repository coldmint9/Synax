import { describe, expect, it } from "vitest";
import { buildPermissionSection } from "../prompt-permission-section.js";
import { synaxAgentProfile } from "../synax/synax-agent-profile.js";
import { permissionRulesForTier } from "../permission-tiers.js";

describe("buildPermissionSection", () => {
  it("summarizes boundary approval gates", () => {
    const section = buildPermissionSection({
      permissionTier: "boundary",
      profileDefaults: synaxAgentProfile.permissionDefaults,
    });
    expect(section).toContain("## Permission gates");
    expect(section).toContain("ALWAYS require user approval");
    expect(section).toContain("cannot bypass");
  });

  it("summarizes unrestricted tier", () => {
    const section = buildPermissionSection({
      permissionTier: "unrestricted",
      profileDefaults: synaxAgentProfile.permissionDefaults,
    });
    expect(section).toContain("Unrestricted");
  });
});

describe("effective permission projection", () => {
  it.each(["boundary", "auto", "unrestricted"] as const)(
    "preserves explicit denials and asks in %s mode",
    (tier) => {
      const section = buildPermissionSection({
        permissionTier: tier,
        profileDefaults: [],
        effectiveRules: [
          ...permissionRulesForTier(tier),
          { gate: "read", pattern: "*", action: "deny" },
          { gate: "write", pattern: "*", action: "ask" },
          { gate: "shell", pattern: "read", action: "deny" },
        ],
      });
      expect(section).toContain("read denied; write requires user approval");
      expect(section).toContain("read-only denied");
      expect(section).not.toContain(
        "Ordinary workspace reads and edits are allowed",
      );
      expect(section).not.toContain("Unrestricted tool permissions");
      expect(section).not.toContain("bash");
      if (tier !== "unrestricted")
        expect(section).toContain("base rules, not final approval");
    },
  );
  it("uses effective rules instead of the tier label or profile defaults", () => {
    const section = buildPermissionSection({
      permissionTier: "unrestricted",
      profileDefaults: synaxAgentProfile.permissionDefaults,
      effectiveRules: [
        { gate: "read", pattern: "*", action: "deny" },
        { gate: "shell", pattern: "*", action: "deny" },
      ],
    });
    expect(section).toContain("read denied");
    expect(section).toContain("read-only denied; mutating denied");
    expect(section).not.toContain("Unrestricted tool permissions");
  });
  it("preserves specific denial patterns rather than declaring blanket unrestricted access", () => {
    const section = buildPermissionSection({
      profileDefaults: [],
      effectiveRules: [
        { gate: "*", pattern: "*", action: "allow" },
        { gate: "read", pattern: "secrets/**", action: "deny" },
        { gate: "shell", pattern: "git:push", action: "ask" },
      ],
    });
    expect(section).toContain("secrets/**");
    expect(section).toContain("git:push");
    expect(section).not.toContain("Unrestricted tool permissions");
    expect(section).toContain("Runtime decisions are authoritative");
  });
  it("matches last-rule-wins ordering and waits rather than performing unauthorized side work", () => {
    const section = buildPermissionSection({
      profileDefaults: [],
      effectiveRules: [
        { gate: "read", pattern: "*", action: "allow" },
        { gate: "read", pattern: "*", action: "deny" },
      ],
    });
    expect(section).toContain("read denied");
    expect(section).toContain("Wait when approval or input is pending");
    expect(section).not.toContain("continue with read-only work");
  });
});
