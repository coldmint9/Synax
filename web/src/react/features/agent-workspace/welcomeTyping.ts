/// <reference lib="es2022.intl" />

/** Stable timing: rerenders must not change the rhythm or split emoji/combining marks. */
export function welcomeTypingSchedule(text: string) {
  const characters =
    typeof Intl.Segmenter === "undefined"
      ? Array.from(text)
      : Array.from(
          new Intl.Segmenter(undefined, { granularity: "grapheme" }).segment(
            text,
          ),
          (part) => part.segment,
        );
  let elapsed = 0;
  const at = characters.map((character, index) => {
    const start = elapsed;
    elapsed += /[，,、；;：:]/u.test(character)
      ? 0.35
      : /[。.!！?？…]/u.test(character)
        ? 0.45
        : /\s/u.test(character)
          ? 0.11
          : [0.075, 0.095, 0.065, 0.11, 0.085][index % 5];
    return start;
  });
  // Duration ends at the final reveal, not the unused pause after the last character.
  return { characters, at, duration: (at[at.length - 1] ?? 0) + 0.1 };
}

export const WELCOME_TITLE_DELAY = 0.2;
export function welcomePlaceholderDelay(title: string) {
  return WELCOME_TITLE_DELAY + welcomeTypingSchedule(title).duration + 0.6;
}
