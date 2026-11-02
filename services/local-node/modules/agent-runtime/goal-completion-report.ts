import { inferLocaleFromText } from "../prompts/locale-infer.js";
import type { VerificationRecord, WorkEvidence } from "./work-store.js";

/**
 * The reply a user reads when a goal is accepted.
 *
 * Acceptance evidence is authoritative, so the report renders the accepted
 * criteria, the changed paths and the verification receipts that the runtime
 * already validated — it never invents completion or a residual-work claim.
 */
export interface GoalCompletionReportInput {
  /** Acceptance reason submitted through goal.finish / work checkpoint. */
  conclusion: string;
  objective?: string | null;
  criteria?: string[];
  evidence?: WorkEvidence[];
  changedPaths?: string[];
  verifications?: VerificationRecord[];
  /** Work the runtime still reports as unfinished when the goal was accepted. */
  remaining?: string[];
  locale?: "zh" | "en";
}

type Locale = "zh" | "en";

const MAX_LISTED_ITEMS = 12;

const LABELS = {
  zh: {
    title: "目标已完成",
    objective: "目标",
    conclusion: "结论",
    changes: (count: number) => `变更（${count} 个文件）：`,
    criteria: (count: number) => `验收标准（${count} 项）：`,
    evidence: (count: number) => `验收证据（${count} 项）：`,
    evidenceFallback: "验收标准：服务端验收证据已通过。",
    verification: (count: number) => `验证（${count} 项）：`,
    unfinishedNone: "未完成项：无",
    unfinished: "未完成项：",
    overflow: (count: number) => `…（另有 ${count} 项）`,
    emptyConclusion: "工作已完成。",
    join: "：",
  },
  en: {
    title: "Goal completed",
    objective: "Objective",
    conclusion: "Conclusion",
    changes: (count: number) => `Changes (${count} files):`,
    criteria: (count: number) => `Acceptance criteria (${count}):`,
    evidence: (count: number) => `Acceptance evidence (${count}):`,
    evidenceFallback: "Acceptance: server-validated evidence passed.",
    verification: (count: number) => `Verification (${count}):`,
    unfinishedNone: "Unfinished: none",
    unfinished: "Unfinished:",
    overflow: (count: number) => `…and ${count} more`,
    emptyConclusion: "The work is complete.",
    join: ": ",
  },
} satisfies Record<Locale, Record<string, unknown>>;

function unique(items: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of items) {
    const value = item.trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function bullets(items: readonly string[], overflow: (count: number) => string): string[] {
  const listed = items.slice(0, MAX_LISTED_ITEMS).map((item) => `- ${item}`);
  const rest = items.length - Math.min(items.length, MAX_LISTED_ITEMS);
  return rest > 0 ? [...listed, `- ${overflow(rest)}`] : listed;
}

function verificationMark(status: VerificationRecord["status"]): string {
  return status === "success" ? "✔" : status === "failed" ? "✘" : "·";
}

function resolveLocale(input: GoalCompletionReportInput): Locale {
  if (input.locale) return input.locale;
  return (
    inferLocaleFromText([input.objective, input.conclusion].filter(Boolean).join("\n")) ?? "en"
  );
}

export function buildGoalCompletionReport(input: GoalCompletionReportInput): string {
  const locale = resolveLocale(input);
  const labels = LABELS[locale];
  const lines = [labels.title, ""];

  if (input.objective?.trim())
    lines.push(`${labels.objective}${labels.join}${input.objective.trim()}`);
  lines.push(
    `${labels.conclusion}${labels.join}${input.conclusion.trim() || labels.emptyConclusion}`,
  );

  const changedPaths = unique(input.changedPaths ?? []);
  if (changedPaths.length)
    lines.push("", labels.changes(changedPaths.length), ...bullets(changedPaths, labels.overflow));

  const criteria = unique(input.criteria ?? []);
  const evidence = input.evidence ?? [];
  const unmatched = evidence.filter(
    (item) => !criteria.some((criterion) => criterion === item.criterion.trim()),
  );
  if (criteria.length) {
    const summaryByCriterion = new Map(
      evidence.map((item) => [item.criterion.trim(), item.summary.trim()] as const),
    );
    lines.push(
      "",
      labels.criteria(criteria.length),
      ...bullets(
        criteria.map((criterion) => {
          const summary = summaryByCriterion.get(criterion);
          return summary ? `${criterion}${labels.join}${summary}` : criterion;
        }),
        labels.overflow,
      ),
    );
  } else if (unmatched.length) {
    lines.push(
      "",
      labels.evidence(unmatched.length),
      ...bullets(
        unmatched.map((item) => `${item.criterion.trim()}${labels.join}${item.summary.trim()}`),
        labels.overflow,
      ),
    );
  } else {
    lines.push("", labels.evidenceFallback);
  }

  const verifications = input.verifications ?? [];
  if (verifications.length)
    lines.push(
      "",
      labels.verification(verifications.length),
      ...bullets(
        verifications.map(
          (record) => `${verificationMark(record.status)} \`${record.command.trim()}\``,
        ),
        labels.overflow,
      ),
    );

  const remaining = unique(input.remaining ?? []);
  if (!remaining.length) {
    lines.push("", labels.unfinishedNone);
    return lines.join("\n");
  }
  lines.push("", labels.unfinished, ...bullets(remaining, labels.overflow));
  return lines.join("\n");
}
