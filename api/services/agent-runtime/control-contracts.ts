import * as z from "zod/v4";

const text = z.string().trim().min(1).max(4000);
export const humanQuestionSchema = z
  .object({
    id: z.string().regex(/^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/),
    type: z.enum([
      "single_select",
      "multi_select",
      "text",
      "textarea",
      "number",
      "boolean",
    ]),
    label: text,
    required: z.boolean().default(true),
    options: z
      .array(z.object({ value: z.string().min(1).max(200), label: text }))
      .min(1)
      .max(20)
      .optional(),
    recommended: z
      .array(z.string().min(1).max(200))
      .min(1)
      .max(20)
      .optional(),
    allowOther: z.boolean().default(false),
    min: z.number().finite().optional(),
    max: z.number().finite().optional(),
  })
  .superRefine((q, ctx) => {
    if (q.type.endsWith("_select") && !q.options?.length)
      ctx.addIssue({
        code: "custom",
        message: "Select questions need options.",
      });
    if (
      q.options &&
      new Set(q.options.map((o) => o.value)).size !== q.options.length
    )
      ctx.addIssue({
        code: "custom",
        message: "Option values must be unique.",
      });
    if (q.recommended) {
      if (!q.type.endsWith("_select"))
        ctx.addIssue({
          code: "custom",
          path: ["recommended"],
          message: "Only select questions can have recommendations.",
        });
      if (q.type === "single_select" && q.recommended.length > 1)
        ctx.addIssue({
          code: "custom",
          path: ["recommended"],
          message: "Single select questions allow one recommendation.",
        });
      const optionValues = new Set(q.options?.map((o) => o.value));
      if (
        new Set(q.recommended).size !== q.recommended.length ||
        q.recommended.some((value) => !optionValues.has(value))
      )
        ctx.addIssue({
          code: "custom",
          path: ["recommended"],
          message: "Recommended values must be unique option values.",
        });
    }
    if (q.min !== undefined && q.max !== undefined && q.min > q.max)
      ctx.addIssue({ code: "custom", message: "min must not exceed max." });
  });
export type HumanQuestion = z.infer<typeof humanQuestionSchema>;
export const humanAskSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    questions: z.array(humanQuestionSchema).min(1).max(5),
  })
  .refine(
    (v) => new Set(v.questions.map((q) => q.id)).size === v.questions.length,
    "Question IDs must be unique.",
  );
export const agentPlanSchema = z
  .object({
    title: z.string().trim().min(1).max(200),
    objective: text,
    steps: z
      .array(
        z.object({
          id: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
          title: text,
          description: text,
          dependsOn: z.array(z.string()).max(40).default([]),
          expectedFiles: z.array(z.string().max(500)).max(80).default([]),
        }),
      )
      .min(1)
      .max(40),
    humanAcceptanceCriteria: z.array(text).max(30).default([]),
    acceptanceCriteria: z.array(text).min(1).max(30),
    assumptions: z.array(text).max(30).default([]),
    risks: z.array(text).max(30).default([]),
  })
  .superRefine((p, ctx) => {
    if (
      p.humanAcceptanceCriteria.some((c) => !p.acceptanceCriteria.includes(c))
    )
      ctx.addIssue({
        code: "custom",
        message: "Human acceptance criteria must belong to the plan.",
      });
    const seen = new Set<string>();
    for (const s of p.steps) {
      if (seen.has(s.id) || s.dependsOn.some((id) => !seen.has(id)))
        ctx.addIssue({
          code: "custom",
          message:
            "Steps must have unique IDs and depend only on earlier steps.",
        });
      seen.add(s.id);
    }
    if (new Set(p.acceptanceCriteria).size !== p.acceptanceCriteria.length)
      ctx.addIssue({
        code: "custom",
        message: "Acceptance criteria must be unique.",
      });
  });
export type AgentPlan = z.infer<typeof agentPlanSchema>;
export const interactionReplySchema = z
  .object({
    revision: z.number().int().positive(),
    action: z.enum([
      "submit",
      "decline",
      "cancel",
      "save",
      "revise",
      "execute",
    ]),
    answers: z
      .record(
        z.string(),
        z.union([
          z.string().max(8000),
          z.array(z.string().max(8000)).max(20),
          z.number().finite(),
          z.boolean(),
        ]),
      )
      .optional(),
    message: z.string().max(8000).optional(),
  })
  .strict();
export type InteractionReply = z.infer<typeof interactionReplySchema>;
export interface AgentInteraction {
  id: string;
  sessionId: string;
  runId: string;
  stepId: string;
  toolCallId: string;
  kind: "clarification" | "plan_approval";
  revision: number;
  status: "pending" | "answered" | "declined" | "cancelled";
  request: {
    title: string;
    questions?: HumanQuestion[];
    plan?: AgentPlan;
    approvalFor?: { planRevision: number; criteria: string[] };
  };
  response: InteractionReply | null;
  createdAt: string;
  resolvedAt: string | null;
}

export function validateAnswers(
  questions: HumanQuestion[],
  answers: InteractionReply["answers"] = {},
): void {
  if (Object.keys(answers).some((id) => !questions.some((q) => q.id === id)))
    throw new Error("Unknown answer field.");
  for (const q of questions) {
    const value = answers[q.id];
    const empty =
      value === undefined ||
      (typeof value === "string" && !value.trim()) ||
      (Array.isArray(value) && !value.length);
    if (empty) {
      if (q.required) throw new Error(`Answer required: ${q.label}`);
      continue;
    }
    const allowed = (v: string) =>
      q.allowOther || q.options?.some((o) => o.value === v);
    const valid =
      q.type === "number"
        ? typeof value === "number" &&
          (q.min === undefined || value >= q.min) &&
          (q.max === undefined || value <= q.max)
        : q.type === "boolean"
          ? typeof value === "boolean"
          : q.type === "multi_select"
            ? Array.isArray(value) &&
              new Set(value).size === value.length &&
              value.every(
                (v) => typeof v === "string" && v.trim() && allowed(v),
              )
            : q.type === "single_select"
              ? typeof value === "string" && allowed(value)
              : typeof value === "string";
    if (!valid) throw new Error(`Invalid answer: ${q.label}`);
  }
}
