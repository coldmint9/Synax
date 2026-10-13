import * as z from 'zod/v4';
const s = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("start"),
    prompt: z.string().trim().min(1).max(100_000),
    profileId: z.enum(["explorer", "reviewer"]).default("explorer"),
    name: z.string().trim().min(1).max(200).optional(),
    thinkingMode: z.enum(["fast", "standard", "deep"]).optional(),
  }),
  z.object({ action: z.literal("list") }),
  z.object({
    action: z.enum(["inspect", "wait"]),
    childSessionId: z.string().min(1).max(64),
  }),
]);
console.log("toJSONSchema:", JSON.stringify(z.toJSONSchema(s, { unrepresentable: "any" }), null, 2));
const { asSchema } = await import('ai');
const parsed = await asSchema(s);
console.log("asSchema.jsonSchema:", JSON.stringify(parsed.jsonSchema, null, 2));
