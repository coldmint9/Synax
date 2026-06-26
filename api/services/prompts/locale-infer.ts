export type InferredLocale = 'zh' | 'en';

const CJK_RE = /[\u4e00-\u9fff\u3400-\u4dbf]/g;
const GREETING_RE = /^(你好|您好|嗨|谢谢|感谢|hi|hello|hey|thanks|thank you)\b/i;

export function inferLocaleFromText(text: string): InferredLocale | null {
  const trimmed = text.trim();
  if (!trimmed) return null;

  const cjkCount = (trimmed.match(CJK_RE) ?? []).length;
  const letterCount = trimmed.replace(/\s/g, '').length;
  if (letterCount > 0 && cjkCount / letterCount >= 0.2) return 'zh';
  if (GREETING_RE.test(trimmed) && cjkCount > 0) return 'zh';

  return null;
}

export function resolvePromptLocale(
  explicit: 'zh' | 'en' | undefined,
  promptText: string,
  fallback: InferredLocale = 'en',
): InferredLocale {
  if (explicit) return explicit;
  return inferLocaleFromText(promptText) ?? fallback;
}
