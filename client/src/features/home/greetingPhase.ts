import type { I18nKey } from "../../shared/lib/i18n";

/** Time-of-day bucket the home greeting reads the clock through. */
export type GreetingPhase = "dawn" | "morning" | "noon" | "afternoon" | "evening" | "late";

export interface GreetingPhaseRule {
  /** Inclusive local hour. */
  from: number;
  /** Exclusive local hour; `late` wraps past midnight into the next day. */
  to: number;
  label: I18nKey;
  /** Copy for a signed-in user; `{name}` is filled from the enterprise account. */
  named: I18nKey;
  /** Copy used without a name, so a stale account never leaks into the greeting. */
  anonymous: I18nKey;
}

/** Day order; also the order the boundaries are tested in. */
export const GREETING_PHASE_ORDER = [
  "dawn",
  "morning",
  "noon",
  "afternoon",
  "evening",
  "late",
] as const satisfies readonly GreetingPhase[];

/**
 * One table for both the hour boundaries and the sentence they select, so a
 * phase can never drift from its copy. 05–08 清晨, 08–11 上午, 11–14 中午,
 * 14–18 下午, 18–23 晚上, 23–05 深夜.
 */
export const GREETING_PHASE_RULES: Record<GreetingPhase, GreetingPhaseRule> = {
  dawn: {
    from: 5,
    to: 8,
    label: "greetingPhaseDawn",
    named: "greetingDawnNamed",
    anonymous: "greetingDawn",
  },
  morning: {
    from: 8,
    to: 11,
    label: "greetingPhaseMorning",
    named: "greetingMorningNamed",
    anonymous: "greetingMorning",
  },
  noon: {
    from: 11,
    to: 14,
    label: "greetingPhaseNoon",
    named: "greetingNoonNamed",
    anonymous: "greetingNoon",
  },
  afternoon: {
    from: 14,
    to: 18,
    label: "greetingPhaseAfternoon",
    named: "greetingAfternoonNamed",
    anonymous: "greetingAfternoon",
  },
  evening: {
    from: 18,
    to: 23,
    label: "greetingPhaseEvening",
    named: "greetingEveningNamed",
    anonymous: "greetingEvening",
  },
  late: {
    from: 23,
    to: 5,
    label: "greetingPhaseLate",
    named: "greetingLateNamed",
    anonymous: "greetingLate",
  },
};

function inside(rule: GreetingPhaseRule, hour: number): boolean {
  return rule.from < rule.to
    ? hour >= rule.from && hour < rule.to
    : hour >= rule.from || hour < rule.to;
}

/** Local time, so the greeting follows the user's own clock rather than a server's. */
export function greetingPhaseAt(date: Date): GreetingPhase {
  const hour = date.getHours();
  for (const phase of GREETING_PHASE_ORDER) {
    if (inside(GREETING_PHASE_RULES[phase], hour)) return phase;
  }
  // The table covers all 24 hours; this keeps the return type total.
  return "late";
}
