import { useEffect, useId, useRef, useState } from "react";
import { Code2 } from "lucide-react";
import { mountPreview, type PreviewConnection } from "./transport";
import {
  acquirePreviewSlot,
  releasePreviewSlot,
  touchPreviewSlot,
} from "./preview-slots";
import "./artifacts.css";

export interface InteractivePrototype {
  id: string;
  title: string;
  sourceKind: "html" | "react";
  html: string;
}
const theme = () =>
  document.documentElement.classList.contains("dark") ||
  document.documentElement.dataset.theme === "dark"
    ? "dark"
    : "light";

export function InteractivePrototypeCard({
  prototype,
}: {
  prototype: InteractivePrototype;
}) {
  return <PrototypeInstance key={prototype.id} prototype={prototype} />;
}
function PrototypeInstance({ prototype }: { prototype: InteractivePrototype }) {
  const uid = useId();
  const card = useRef<HTMLElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const connection = useRef<PreviewConnection | null>(null);
  const activate = useRef<() => void>(() => {});
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState("");
  const [height, setHeight] = useState(300);
  const { id, html, title } = prototype;
  useEffect(() => {
    let disposed = false,
      pending = false,
      generation = 0,
      failed = false;
    const stop = async () => {
      generation++;
      connection.current?.destroy();
      connection.current = null;
      releasePreviewSlot(uid);
      if (!disposed) setConnected(false);
    };
    const start = () => {
      if (
        disposed ||
        pending ||
        failed ||
        document.hidden ||
        connection.current ||
        !container.current
      )
        return;
      pending = true;
      const attempt = ++generation;
      void acquirePreviewSlot(uid, stop)
        .then(() => {
          pending = false;
          if (disposed || attempt !== generation) {
            releasePreviewSlot(uid);
            return;
          }
          connection.current = mountPreview({
            container: container.current!,
            html,
            prototypeId: id,
            title,
            onRequest: (type, payload) => {
              if (disposed) throw new Error("Prototype stopped");
              if (type === "ready")
                return {
                  theme: theme(),
                  locale: document.documentElement.lang || navigator.language,
                };
              if (type === "resize") {
                const next = (payload as { height?: unknown })?.height;
                if (typeof next !== "number" || !Number.isFinite(next))
                  throw new Error("Invalid height");
                setHeight(Math.max(96, Math.min(720, Math.round(next))));
                return null;
              }
              throw new Error("Unsupported prototype request");
            },
            onConnected: () => {
              if (!disposed) setConnected(true);
            },
            onError: (e) => {
              if (!disposed) {
                failed = true;
                setError(e.message);
                void stop();
              }
            },
          });
        })
        .catch((e) => {
          pending = false;
          if (!disposed) {
            failed = true;
            setError(String(e));
          }
        });
    };
    activate.current = start;
    // Eviction does not automatically reacquire: three visible cards must not churn leases.
    // A parked card resumes on focus/pointer or when it re-enters the viewport.
    const observer =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(
            (entries) => {
              if (entries[0]?.isIntersecting) start();
              else void stop();
            },
            { rootMargin: "100px" },
          );
    if (observer && card.current) observer.observe(card.current);
    else start();
    const visibility = () => {
      if (document.hidden) void stop();
      else if (card.current) {
        const r = card.current.getBoundingClientRect();
        if (r.bottom >= 0 && r.top <= innerHeight) start();
      }
    };
    document.addEventListener("visibilitychange", visibility);
    const themes = new MutationObserver(() =>
      connection.current?.send("theme", { theme: theme() }),
    );
    themes.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme"],
    });
    return () => {
      disposed = true;
      activate.current = () => {};
      observer?.disconnect();
      themes.disconnect();
      document.removeEventListener("visibilitychange", visibility);
      void stop();
    };
  }, [uid, id, html, title]);
  useEffect(() => {
    connection.current?.update();
  }, [height]);
  const interact = () => {
    touchPreviewSlot(uid);
    activate.current();
  };
  return (
    <article
      ref={card}
      className="prototype-card"
      aria-label={title}
      tabIndex={0}
      onPointerEnter={interact}
      onPointerDownCapture={interact}
      onFocusCapture={interact}
    >
      <div className="prototype-card-header">
        <Code2 size={15} className="prototype-card-mark" aria-hidden="true" />
        <span
          className="prototype-card-status"
          data-live={connected || undefined}
          role="status"
          aria-label={
            error ? "预览不可用" : connected ? "可交互原型" : "原型预览"
          }
        >
          <i aria-hidden="true" />
        </span>
        <div className="prototype-card-title">{title}</div>
      </div>
      {error ? (
        <div className="prototype-error" role="alert">
          原型无法显示：{error}
        </div>
      ) : (
        <div className="prototype-card-preview" style={{ height }}>
          <div ref={container} className="artifact-preview-container" />
        </div>
      )}
    </article>
  );
}
