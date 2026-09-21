import { readSessionUserPrompt } from "./sessionMetadata";
import { useMemo } from "react";
import type { AgentSession } from "../../../lib/api/agentRuntime";
import { useLocale } from "../../../hooks/useLocale";
import { t, type Locale } from "../../../lib/i18n";

export const SESSION_DISPLAY_TITLE_MAX = 80;

/** Placeholder titles only mean "not summarized yet"; they are localized. */
const PLACEHOLDER_TITLES = ["new session", "new chat", "new agent", "新会话", "新对话"];

function isPlaceholderTitle(title: string): boolean {
  return PLACEHOLDER_TITLES.includes(title.trim().toLowerCase());
}

function looksLikeSystemPrompt(prompt: string): boolean {
  return prompt.includes("## ") || /^You are\b/m.test(prompt);
}

function truncateDisplayTitle(
  text: string,
  max = SESSION_DISPLAY_TITLE_MAX,
): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) return trimmed;
  return `${trimmed.slice(0, max - 1)}…`;
}

export function resolveSessionUserInput(session: AgentSession): string | null {
  const userPrompt = readSessionUserPrompt(session.sessionMetadata);
  if (userPrompt) return userPrompt;
  const planNodeTitle = session.sessionMetadata?.planNodeTitle;
  if (typeof planNodeTitle === "string" && planNodeTitle.trim()) {
    return planNodeTitle.trim();
  }
  return null;
}

export function getSessionDisplayTitle(
  session: AgentSession,
  fallback = "",
  locale: Locale = "en",
): string {
  const title = session.title?.trim();
  if (title && isPlaceholderTitle(title))
    return t(locale, "sessionPlaceholderTitle");
  if (title) return title;

  const userInput = resolveSessionUserInput(session);
  if (userInput) return truncateDisplayTitle(userInput);

  const prompt = session.prompt.trim();
  if (prompt && prompt.length <= 120 && !looksLikeSystemPrompt(prompt)) {
    return truncateDisplayTitle(prompt);
  }
  if (prompt) return prompt.slice(0, 50);
  return fallback;
}

export function useSessionDisplayTitle(
  session: AgentSession | null | undefined,
  fallback = "",
): string {
  const { locale } = useLocale();
  return useMemo(
    () =>
      session ? getSessionDisplayTitle(session, fallback, locale) : fallback,
    [
      session,
      fallback,
      locale,
      session?.title,
      session?.prompt,
      readSessionUserPrompt(session?.sessionMetadata),
      session?.sessionMetadata?.planNodeTitle,
    ],
  );
}
