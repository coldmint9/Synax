import { describe, expect, it } from "vitest";
import { formatCompletionTimestamp } from "../formatCompletionTimestamp";

const now = new Date("2026-09-29T20:15:00+08:00");

describe("formatCompletionTimestamp", () => {
  it("omits the date for a turn completed the same day", () => {
    expect(formatCompletionTimestamp("2026-09-29T14:32:00+08:00", now)).toBe(
      "14:32",
    );
  });

  it("keeps month and day within the current year", () => {
    expect(formatCompletionTimestamp("2026-09-28T09:05:00+08:00", now)).toBe(
      "09-28 09:05",
    );
  });

  it("keeps the year for an older turn", () => {
    expect(formatCompletionTimestamp("2025-09-28T23:59:00+08:00", now)).toBe(
      "2025-09-28 23:59",
    );
  });

  it("returns null for missing or unparseable input", () => {
    expect(formatCompletionTimestamp(null, now)).toBeNull();
    expect(formatCompletionTimestamp(undefined, now)).toBeNull();
    expect(formatCompletionTimestamp("not-a-date", now)).toBeNull();
  });
});
