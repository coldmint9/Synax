import { agentRuntimeStore } from "./session-store.js";
import type {
  TitleGenerator,
  TitleGeneratorContext,
} from "./session-title-service.js";
import { getSessionUserPrompt } from "./session-metadata.js";
import { generateSessionTitleWithModel } from "./session-title-llm.js";

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

export const sessionTitleGenerator: TitleGenerator = {
  generate(ctx: TitleGeneratorContext) {
    const session = agentRuntimeStore.tryGetSession(ctx.sessionId);
    const userInput = resolveSessionTitleInput({
      sessionMetadata: session?.sessionMetadata ?? null,
      prompt: ctx.prompt,
    });
    if (!userInput) return null;
    return generateSessionTitleWithModel({
      sessionId: ctx.sessionId,
      projectId: ctx.projectId,
      userInput,
    });
  },
};
