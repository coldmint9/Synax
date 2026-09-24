import { useEffect, useRef, useState } from "react";
import { visualizationDocument, VISUALIZATION_CSP } from "./document";
import "./visualizations.css";

export interface InlineVisualizationReference {
  id: string;
  html?: string;
  title?: string;
  mode?: "wide";
  error?: string;
}

const MAX_HEIGHT = 8192;
function currentTheme(): "light" | "dark" {
  return document.documentElement.classList.contains("dark") ||
    document.documentElement.dataset.theme === "dark"
    ? "dark"
    : "light";
}
function randomToken(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(24)), (value) =>
    value.toString(16).padStart(2, "0"),
  ).join("");
}

export function InlineVisualization({
  visualization,
}: {
  visualization: InlineVisualizationReference;
}) {
  return (
    <VisualizationInstance
      key={visualization.id}
      visualization={visualization}
    />
  );
}
function VisualizationInstance({
  visualization,
}: {
  visualization: InlineVisualizationReference;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [error, setError] = useState(visualization.error ?? "");
  const [ready, setReady] = useState(false);
  const { id, html, title } = visualization;

  useEffect(() => {
    const host = container.current;
    if (!host || !html || error) return;
    // Set srcdoc before insertion so an initial about:blank load cannot race the handshake.
    const element = document.createElement("iframe");
    element.className = "inline-visualization__frame";
    element.title = title || "交互预览";
    element.loading = "lazy";
    element.referrerPolicy = "no-referrer";
    element.setAttribute("sandbox", "allow-scripts");
    element.setAttribute(
      "allow",
      "camera 'none'; microphone 'none'; geolocation 'none'; clipboard-read 'none'; clipboard-write 'none'",
    );
    element.style.height = "240px";
    let loadCount = 0;
    const token = randomToken();
    const binding = { channel: "synax-visualization", id, token };
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let connected = false;
    let received = 0;
    let windowStart = performance.now();
    const fail = () => setError("预览未能运行，请让助手修正后重新生成。");
    const sendTheme = () =>
      element.contentWindow?.postMessage(
        { ...binding, type: "theme", theme: currentTheme() },
        "*",
      );
    const onMessage = (event: MessageEvent) => {
      const data = event.data;
      if (
        event.source !== element.contentWindow ||
        data?.channel !== binding.channel ||
        data.id !== id ||
        data.token !== token
      )
        return;
      const now = performance.now();
      if (now - windowStart > 1000) {
        windowStart = now;
        received = 0;
      }
      if (++received > 120) {
        fail();
        return;
      }
      if (data.type === "ready" && !connected) {
        connected = true;
        clearTimeout(timeout);
        setReady(true);
        sendTheme();
      }
      if (data.type === "error" || data.type === "exit") fail();
      if (
        data.type === "resize" &&
        typeof data.height === "number" &&
        Number.isFinite(data.height)
      )
        element.style.height = `${Math.max(48, Math.min(MAX_HEIGHT, Math.ceil(data.height)))}px`;
    };
    const loaded = () => {
      if (++loadCount > 1) {
        fail();
        return;
      }
      sendTheme();
    };
    const startTimeout = () => {
      if (!connected) timeout ??= setTimeout(fail, 10_000);
    };
    const intersection =
      typeof IntersectionObserver === "undefined"
        ? null
        : new IntersectionObserver(
            (entries) => {
              if (entries.some((entry) => entry.isIntersecting)) startTimeout();
            },
            { rootMargin: "200px" },
          );
    intersection?.observe(element);
    if (!intersection) startTimeout();
    window.addEventListener("message", onMessage);
    element.addEventListener("load", loaded);
    const observer = new MutationObserver(sendTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme"],
    });
    element.setAttribute("csp", VISUALIZATION_CSP);
    element.srcdoc = visualizationDocument(html, {
      id,
      token,
      theme: currentTheme(),
    });
    host.append(element);
    return () => {
      clearTimeout(timeout);
      intersection?.disconnect();
      observer.disconnect();
      window.removeEventListener("message", onMessage);
      element.removeEventListener("load", loaded);
      element.remove();
    };
  }, [id, html, title, error]);

  return (
    <div
      className="inline-visualization"
      data-visualization-id={id}
      data-mode={visualization.mode}
      aria-busy={!ready && !error}
    >
      {error ? (
        <div className="inline-visualization__error" role="alert">
          <strong>预览不可用</strong>
          <span>{error}</span>
        </div>
      ) : (
        <div ref={container} />
      )}
    </div>
  );
}
