import { beforeEach, describe, expect, it } from "vitest";
import {
  PERMISSION_TIER_PREFERENCE_KEY,
  readLastPermissionTier,
  rememberPermissionTier,
  usePermissionTierPreference,
} from "../permissionTierPreference";

describe("permission tier preference", () => {
  beforeEach(() => {
    localStorage.clear();
    usePermissionTierPreference.setState({ lastTier: "boundary" });
  });

  it("falls back to boundary when nothing was recorded", () => {
    expect(readLastPermissionTier()).toBe("boundary");
  });

  it("remembers the last picked tier so the next session inherits it", () => {
    rememberPermissionTier("unrestricted");
    expect(readLastPermissionTier()).toBe("unrestricted");
    expect(localStorage.getItem(PERMISSION_TIER_PREFERENCE_KEY)).toContain(
      "unrestricted",
    );
  });

  it("ignores a stored value that is not a known tier", () => {
    usePermissionTierPreference.setState({
      lastTier: "yolo" as never,
    });
    expect(readLastPermissionTier()).toBe("boundary");
  });
});
