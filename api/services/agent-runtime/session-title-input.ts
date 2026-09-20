import { agentRuntimeStore } from "./session-store.js";
import type {
  TitleGenerator,
  TitleGeneratorContext,
} from "./session-title-service.js";
import { generateGatewayTextResult } from "../llm-runtime/gateway.js";
import { getSessionUserPrompt } from "./session-metadata.js";

export function extractLegacyUserRequestFromPrompt(
  prompt: string,
): string | null {
  const marker = "## User Goal";
  const idx = prompt.indexOf(marker);
  if (idx === -1) return null;
  const after = prompt.slice(idx + marker.length);
  const nextSection = after.search(/\n## /);
  const block = (
    nextSection === -1 ? after : after.slice(0, nextSection)
  ).trim();
  return block || null;
}

export function extractPlanNodeTitleFromPrompt(prompt: string): string | null {
  const match = prompt.match(/- \*\*Title\*\*: (.+)/);
  return match?.[1]?.trim() || null;
}

export function resolveSessionTitleInput(input: {
  sessionMetadata: Record<string, unknown> | null;
  prompt: string;
}): string | null {
  const meta = input.sessionMetadata;
  if (meta) {
    const userPrompt = getSessionUserPrompt(meta);
    if (userPrompt) return userPrompt;
    const planNodeTitle = meta.planNodeTitle;
    if (typeof planNodeTitle === "string" && planNodeTitle.trim()) {
      return planNodeTitle.trim();
    }
  }

  return (
    extractLegacyUserRequestFromPrompt(input.prompt) ??
    extractPlanNodeTitleFromPrompt(input.prompt)
  );
}

async function generateSessionTitleWithLlm(
  projectId: string,
  userInput: string,
): Promise<string | null> {
  const truncated = userInput.slice(0, 600);
  const result = await generateGatewayTextResult({
    projectId,
    purpose: "session-title",
    messages: [
      {
        role: "user",
        content: [
          "Generate a short title (max 10 Chinese characters or 6 English words) from the user input below.",
          "Return ONLY the title, no quotes or punctuation.",
          "",
          truncated,
        ].join("\n"),
      },
    ],
    maxTokens: 128,
    temperature: 0.3,
  });

  const title = (result.text ?? "").trim().slice(0, 50);
  return title || null;
}

export const sessionTitleGenerator: TitleGenerator = {
  generate(ctx: TitleGeneratorContext) {
    const session = agentRuntimeStore.tryGetSession(ctx.sessionId);
    const userInput = resolveSessionTitleInput({
      sessionMetadata: session?.sessionMetadata ?? null,
      prompt: ctx.prompt,
    });
    if (!userInput) return null;
    return generateSessionTitleWithLlm(ctx.projectId, userInput);
  },
};
