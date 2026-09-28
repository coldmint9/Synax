import { useLayoutEffect, useRef, type ReactNode } from "react";
import { loadMotion, reducedMotion } from "../../design/motion";
import "./newSessionWelcome.css";

/** Owns welcome-only transforms. Nested entrance targets never compete with pointer transforms. */
export function NewSessionScene({
  children,
  paused,
}: {
  children: ReactNode;
  paused: boolean;
}) {
  const root = useRef<HTMLDivElement>(null);
  const resetMotion = useRef<() => void>(() => {});

  useLayoutEffect(() => {
    const scene = root.current;
    if (!scene || reducedMotion()) return;
    let active = true;
    let cleanup = () => {};
    void loadMotion()
      .then((gsap) => {
        if (!active || reducedMotion()) return;
        const media = window.matchMedia("(prefers-reduced-motion: reduce)");
        const pointer = window.matchMedia("(hover: hover) and (pointer: fine)");
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
        const layers = Array.from(
          scene.querySelectorAll<HTMLElement>("[data-welcome-layer]"),
        ).map((element) => ({
          element,
          distance:
            element.dataset.welcomeLayer === "mark"
              ? 6
              : element.dataset.welcomeLayer === "title"
                ? 4
                : 2,
          x: gsap.quickTo(element, "x", { duration: 0.65, ease: "power3.out" }),
          y: gsap.quickTo(element, "y", { duration: 0.65, ease: "power3.out" }),
        }));
        let bounds: DOMRect | null = null;
        let stopped = false;
        const reset = () => {
          bounds = null;
          if (stopped) return;
          layers.forEach((layer) => {
            layer.x(0);
            layer.y(0);
          });
        };
        const stop = () => {
          stopped = true;
          bounds = null;
          layers.forEach((layer) => {
            layer.x.tween.kill();
            layer.y.tween.kill();
            gsap.set(layer.element, { clearProps: "transform" });
          });
          context.revert();
        };
        const blocked = () =>
          stopped ||
          scene.dataset.motionPaused === "true" ||
          media.matches ||
          document.hidden ||
          !pointer.matches ||
          Boolean(
            scene.querySelector('[aria-haspopup][aria-expanded="true"]'),
          ) ||
          (scene.contains(document.activeElement) &&
            document.activeElement?.matches(
              'textarea, input, [contenteditable="true"]',
            ));
        const move = (event: PointerEvent) => {
          if (event.pointerType === "touch" || blocked()) return;
          bounds ??= scene.getBoundingClientRect();
          if (!bounds.width || !bounds.height) return;
          const x = Math.max(
            -1,
            Math.min(1, ((event.clientX - bounds.left) / bounds.width) * 2 - 1),
          );
          const y = Math.max(
            -1,
            Math.min(1, ((event.clientY - bounds.top) / bounds.height) * 2 - 1),
          );
          layers.forEach((layer) => {
            layer.x(x * layer.distance);
            layer.y(y * layer.distance);
          });
        };
        const preference = () => {
          if (media.matches) stop();
          else reset();
        };
        const hidden = () => {
          if (document.hidden) reset();
        };
        resetMotion.current = reset;
        scene.addEventListener("pointermove", move, { passive: true });
        scene.addEventListener("pointerleave", reset);
        scene.addEventListener("focusin", reset);
        scene.addEventListener("pointerdown", reset);
        window.addEventListener("resize", reset, { passive: true });
        window.addEventListener("scroll", reset, {
          passive: true,
          capture: true,
        });
        document.addEventListener("visibilitychange", hidden);
        media.addEventListener("change", preference);
        pointer.addEventListener("change", reset);
        cleanup = () => {
          resetMotion.current = () => {};
          scene.removeEventListener("pointermove", move);
          scene.removeEventListener("pointerleave", reset);
          scene.removeEventListener("focusin", reset);
          scene.removeEventListener("pointerdown", reset);
          window.removeEventListener("resize", reset);
          window.removeEventListener("scroll", reset, true);
          document.removeEventListener("visibilitychange", hidden);
          media.removeEventListener("change", preference);
          pointer.removeEventListener("change", reset);
          stop();
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

  useLayoutEffect(() => {
    if (paused) resetMotion.current();
  }, [paused]);
  return (
    <div
      ref={root}
      data-motion-paused={paused ? "true" : undefined}
      className="session-welcome-layout flex w-full max-w-3xl flex-col items-center gap-6"
    >
      {children}
    </div>
  );
}
