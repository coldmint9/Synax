import { useLayoutEffect, useMemo, useRef } from "react";
import { loadMotion, reducedMotion } from "../../design/motion";
import "./visualizations.css";

const ASCII = "01{}[]<>/\\|=+-_*#@$%&:;,.";

function makeRows(count: number, width: number): string[] {
  return Array.from({ length: count }, (_, row) =>
    Array.from({ length: width }, (_, column) => {
      const index = (row * 17 + column * 31 + row * column) % ASCII.length;
      return ASCII[index];
    }).join(""),
  );
}

export function VisualizationLoading({ compact = false }: { compact?: boolean }) {
  const root = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => makeRows(9, 62), []);

  useLayoutEffect(() => {
    const element = root.current;
    if (!element || reducedMotion()) return;

    let active = true;
    let context: { revert: () => void } | undefined;
    let pause = () => {};
    const media = window.matchMedia("(prefers-reduced-motion: reduce)");

    void loadMotion()
      .then((gsap) => {
        if (!active || media.matches || !root.current) return;
        context = gsap.context(() => {
          const cells = gsap.utils.toArray<HTMLElement>("[data-loading-cell]");
          const breathing = gsap.to(cells, {
            opacity: 0.2,
            color: "#7dd3be",
            duration: 1.5,
            repeat: -1,
            yoyo: true,
            ease: "sine.inOut",
            stagger: {
              each: 0.035,
              from: "random",
              repeat: -1,
              yoyo: true,
            },
          });
          const beam = gsap.to("[data-loading-beam]", {
            xPercent: 115,
            duration: 3.8,
            repeat: -1,
            ease: "power1.inOut",
          });
          pause = () => {
            const paused = document.hidden;
            breathing.paused(paused);
            beam.paused(paused);
          };
          pause();
        }, element);
      })
      .catch(() => {});

    const onVisibility = () => pause();
    const onMotionChange = () => {
      if (media.matches) {
        context?.revert();
      }
    };
    document.addEventListener("visibilitychange", onVisibility);
    media.addEventListener("change", onMotionChange);
    return () => {
      active = false;
      document.removeEventListener("visibilitychange", onVisibility);
      media.removeEventListener("change", onMotionChange);
      context?.revert();
    };
  }, []);

  return (
    <div
      ref={root}
      className={`visualization-loading${compact ? " visualization-loading--compact" : ""}`}
      role="status"
      aria-label="正在生成交互预览"
    >
      <div className="visualization-loading__label">
        <span className="visualization-loading__signal">●</span>
        PREPARING INTERACTIVE VIEW
      </div>
      <div className="visualization-loading__art" aria-hidden="true">
        <div className="visualization-loading__beam" data-loading-beam="" />
        <pre>
          {rows.map((row, rowIndex) => (
            <span key={rowIndex}>
              {Array.from(row, (character, columnIndex) => (
                <i
                  key={`${rowIndex}-${columnIndex}`}
                  data-loading-cell=""
                >
                  {character}
                </i>
              ))}
              {"\n"}
            </span>
          ))}
        </pre>
      </div>
      <div className="visualization-loading__hint">
        构建界面 · 编译交互 · 等待预览就绪
      </div>
    </div>
  );
}
