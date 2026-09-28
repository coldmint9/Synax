import { useLayoutEffect, useRef } from "react";
import { loadMotion, reducedMotion } from "../../design/motion";
import { welcomeTypingSchedule } from "./welcomeTyping";

/** Visual text only; a separate complete label avoids per-character screen-reader announcements. */
export function WelcomeTypewriter({
  text,
  delay = 0,
  finish = false,
  decorative = false,
}: {
  text: string;
  delay?: number;
  finish?: boolean;
  decorative?: boolean;
}) {
  const root = useRef<HTMLSpanElement>(null);
  const completed = useRef<string | null>(null);
  const { characters } = welcomeTypingSchedule(text);

  useLayoutEffect(() => {
    const element = root.current;
    if (!element) return;
    if (finish || reducedMotion() || completed.current === text || !text) {
      completed.current = text;
      return;
    }
    let active = true;
    let settled = false;
    let revert = () => {};
    let visibility = () => {};
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");
    const spans = Array.from(
      element.querySelectorAll<HTMLElement>("[data-typewriter-char]"),
    );
    const reveal = () => {
      settled = true;
      completed.current = text;
      revert();
      delete element.dataset.typing;
      spans.forEach((span) => {
        delete span.dataset.caret;
      });
    };
    const reduce = () => {
      if (media.matches) reveal();
    };
    element.dataset.typing = "true";
    media.addEventListener("change", reduce);
    void loadMotion()
      .then((gsap) => {
        if (!active || settled) return;
        if (reducedMotion()) {
          reveal();
          return;
        }
        const schedule = welcomeTypingSchedule(text);
        const context = gsap.context(() => {
          const timeline = gsap.timeline({ delay, onComplete: reveal });
          schedule.at.forEach((at, index) => {
            timeline.call(
              () => {
                if (index > 0) delete spans[index - 1].dataset.caret;
                spans[index].dataset.caret = "true";
              },
              [],
              at,
            );
            timeline.to(
              spans[index],
              { opacity: 1, duration: 0.1, ease: "power1.out" },
              at,
            );
          });
          // Let the final caret breathe briefly, then remove all animation styles.
          timeline.call(() => {}, [], schedule.duration + 0.65);
          visibility = () => {
            if (document.hidden) timeline.pause();
            else timeline.resume();
          };
          document.addEventListener("visibilitychange", visibility);
          visibility();
        }, element);
        revert = () => context.revert();
      })
      .catch(() => {
        if (active) reveal();
      });
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", visibility);
      media.removeEventListener("change", reduce);
      revert();
      delete element.dataset.typing;
      spans.forEach((span) => {
        delete span.dataset.caret;
      });
    };
  }, [text, delay, finish]);

  return (
    <>
      {!decorative && <span className="sr-only">{text}</span>}
      <span ref={root} data-welcome-typewriter="" aria-hidden="true">
        {characters.map((character, index) => (
          <span key={`${text}-${index}`} data-typewriter-char="">
            {character}
          </span>
        ))}
      </span>
    </>
  );
}
