// ---------------------------------------------------------------------------
// api/services/prompts/language-directive.ts
//
// Unified language output directive injected at the top of LLM prompts.
// All prompts are written in English; this directive tells the model which
// language to use for user-facing output while keeping internal reasoning
// in English.
// ---------------------------------------------------------------------------

export type Locale = 'zh' | 'en';

const LANGUAGE_LABELS: Record<Locale, string> = {
  zh: 'Chinese (Simplified)',
  en: 'English',
};

/**
 * Reminder for wiki outline generation: titles and keyQuestions follow UI locale.
 */
export function buildOutlineLanguageRequirement(locale: Locale): string {
  const lang = LANGUAGE_LABELS[locale];
  return [
    '## Outline Language',
    `Write every document **title** and **keyQuestion** in ${lang}.`,
    'Keep document ids, docType values, and targetFiles paths in English.',
  ].join('\n');
}

/**
 * Build a language output directive to be prepended to LLM system prompts.
 *
 * Tells the model to think/process internally in English but produce all
 * user-facing output (titles, headings, paragraphs, lists, tables, diagrams,
 * decisions, risks, etc.) in the configured language.
 *
 * Tool argument values, tool names, JSON keys, source code references, and
 * file paths are exempt and stay in English.
 */
export function buildLanguageDirective(locale: Locale): string {
  const lang = LANGUAGE_LABELS[locale];
  return [
    '## Language Output Directive',
    `Think and process internally in English. All final output — document titles, section headings, paragraph content, list items, table cell text, diagram labels, decision/risk descriptions, and any other user-facing text — must be written in ${lang}.`,
    'Tool argument values are exempt: tool names and JSON keys stay in English. Source code references and file paths are exempt.',
    '',
  ].join('\n');
}
