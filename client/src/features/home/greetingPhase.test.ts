import { describe, expect, it } from "vitest";
import {
  GREETING_PHASE_ORDER,
  GREETING_PHASE_RULES,
  greetingPhaseAt,
  type GreetingPhase,
} from "./greetingPhase";

/** Local time on an arbitrary day; only the hour matters. */
const at = (hour: number, minute = 0) => new Date(2026, 0, 15, hour, minute);

const BOUNDARIES: [number, number, GreetingPhase][] = [
  [0, 0, "late"],
  [4, 59, "late"],
  [5, 0, "dawn"],
  [7, 59, "dawn"],
  [8, 0, "morning"],
  [10, 59, "morning"],
  [11, 0, "noon"],
  [13, 59, "noon"],
  [14, 0, "afternoon"],
  [17, 59, "afternoon"],
  [18, 0, "evening"],
  [22, 59, "evening"],
  [23, 0, "late"],
  [23, 59, "late"],
];

describe("greeting phase", () => {
  it.each(BOUNDARIES)("maps %i:%i to %s", (hour, minute, phase) => {
    expect(greetingPhaseAt(at(hour, minute))).toBe(phase);
  });

  it("assigns every hour of the day to exactly one phase", () => {
    const seen = new Set<GreetingPhase>();
    for (let hour = 0; hour < 24; hour += 1) seen.add(greetingPhaseAt(at(hour)));
    expect([...seen].sort()).toEqual([...GREETING_PHASE_ORDER].sort());
  });

  it("agrees with the hour stated in each rule", () => {
    for (const phase of GREETING_PHASE_ORDER) {
      const rule = GREETING_PHASE_RULES[phase];
      expect(greetingPhaseAt(at(rule.from))).toBe(phase);
      // The hour before the start belongs to the previous phase, never this one.
      expect(greetingPhaseAt(at((rule.from + 23) % 24))).not.toBe(phase);
    }
  });
});
