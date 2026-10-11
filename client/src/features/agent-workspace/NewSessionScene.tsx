import { useLayoutEffect, useRef, type ReactNode } from "react";
import { loadMotion, reducedMotion } from "../../shared/design/motion";
import "./newSessionWelcome.css";

/** Owns the welcome entrance animations. */
export function NewSessionScene({ children }: { children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const scene = root.current;
    if (!scene || reducedMotion()) return;
    let active = true;
    let cleanup = () => {};
    void loadMotion()
      .then((gsap) => {
        if (!active || reducedMotion()) return;
        const media = window.matchMedia("(prefers-reduced-motion: reduce)");
        const context = gsap.context(() => {
          gsap.fromTo(
            ".synax-wordmark",
            { opacity: 0, y: 6 },
            {
              opacity: 1,
              y: 0,
              duration: 0.5,
              ease: "power3.out",
              clearProps: "transform,opacity",
            },
          );
          gsap.fromTo(
            "[data-welcome-enter]",
            { opacity: 0, y: 12 },
            {
              opacity: 1,
              y: 0,
              delay: 0.12,
              duration: 0.6,
              ease: "power3.out",
              clearProps: "transform,opacity",
            },
          );
        }, scene);
        const preference = () => {
          if (media.matches) context.revert();
        };
        media.addEventListener("change", preference);
        cleanup = () => {
          media.removeEventListener("change", preference);
          context.revert();
        };
      })
      .catch(() => {
        /* Motion is optional; never hide or disable the composer on chunk failure. */
      });
    return () => {
      active = false;
      cleanup();
    };
  }, []);

  return (
    <div
      ref={root}
      className="session-welcome-layout flex w-full max-w-3xl flex-col items-center gap-6"
    >
      {children}
    </div>
  );
}
