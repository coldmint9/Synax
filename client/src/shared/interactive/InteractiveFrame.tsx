import { useEffect, useRef, useState } from "react";
import { interactiveDocument, INTERACTIVE_CSP } from "./document";
import { readInteractiveState, writeInteractiveState } from "./state-store";
import "./frame.css";

/** Message channel spoken by runtime.js inside the frame. */
export const INTERACTIVE_CHANNEL = "synax-interactive";
const DEFAULT_MAX_HEIGHT = 8192;
const DEFAULT_TIMEOUT_MS = 20_000;
const INITIAL_HEIGHT = 240;
/** Resize bursts are normal for animated apps; only sustained abuse is fatal. */
const MESSAGE_LIMIT = 240;
const MESSAGE_WINDOW_MS = 1000;
const MESSAGE_STRIKES = 3;

export interface InteractiveFrameProps {
  /** Stable instance identity; a new id installs a new frame and token. */
  id: string;
  /** Self-contained HTML fragment (no document shell). */
  html: string;
  title: string;
  className?: string;
  /** Height ceiling; longer content scrolls inside the frame. */
  maxHeight?: number;
  /** Time allowed for the frame to open its authenticated channel. */
  timeoutMs?: number;
  /** Persist `window.openai.widgetState` across remounts under this key. */
  stateKey?: string;
  /** Locale forwarded to the frame; defaults to the document locale. */
  locale?: string;
  onReady?(): void;
  onError?(message: string): void;
}

export function currentTheme(): "light" | "dark" {
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

/**
 * Renders one self-contained HTML application inside an opaque-origin iframe.
 *
 * The container owns the sandbox contract only: CSP, authenticated handshake,
 * theme propagation, height tracking, resize back-pressure and state snapshots.
 * Product chrome, loading text and error copy stay with the caller, which is why
 * chat previews, file previews and full-screen apps can share this component.
 */
export function InteractiveFrame({
  id,
  html,
  title,
  className,
  maxHeight = DEFAULT_MAX_HEIGHT,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  stateKey,
  locale,
  onReady,
  onError,
}: InteractiveFrameProps) {
  const host = useRef<HTMLDivElement>(null);
  const callbacks = useRef({ onReady, onError });
  callbacks.current = { onReady, onError };
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [overflow, setOverflow] = useState(false);

  useEffect(() => {
    const container = host.current;
    if (!container) return;
    setPhase("loading");
    setOverflow(false);
    // Set srcdoc before insertion so an initial about:blank load cannot race the handshake.
    const element = document.createElement("iframe");
    element.className = "interactive-frame__frame";
    element.title = title;
    // Previews are conversation content, not below-the-fold media. Lazy iframe
    // loading can prevent the document from ever reaching the ready handshake.
    element.loading = "eager";
    element.referrerPolicy = "no-referrer";
    element.setAttribute("sandbox", "allow-scripts");
    // Do not delegate device or clipboard permissions. Their default `self`
    // allowlists exclude this opaque sandbox origin.
    element.style.height = `${INITIAL_HEIGHT}px`;
    let loadCount = 0;
    const token = randomToken();
    const binding = { channel: INTERACTIVE_CHANNEL, id, token };
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let connected = false;
    let received = 0;
    let windowStart = performance.now();
    let strikes = 0;
    let failed = false;
    const fail = (message: string) => {
      if (failed) return;
      failed = true;
      clearTimeout(timeout);
      setPhase("error");
      callbacks.current.onError?.(message);
    };
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
      if (now - windowStart > MESSAGE_WINDOW_MS) {
        // Judge the window that just closed. A single burst is a legitimate
        // animation frame loop; only sustained overload over several windows
        // is treated as a runaway document.
        strikes = received > MESSAGE_LIMIT ? strikes + 1 : 0;
        windowStart = now;
        received = 0;
        if (strikes >= MESSAGE_STRIKES) {
          fail("预览消息过于频繁，已停止运行，请让助手简化交互后重新生成。");
          return;
        }
      }
      if (++received > MESSAGE_LIMIT) return;
      if (data.type === "ready" && !connected) {
        connected = true;
        clearTimeout(timeout);
        setPhase("ready");
        sendTheme();
        callbacks.current.onReady?.();
      }
      if (data.type === "error" || data.type === "exit") {
        fail("预览未能运行，请让助手修正后重新生成。");
        return;
      }
      if (data.type === "state" && stateKey && data.state) {
        writeInteractiveState(stateKey, data.state);
      }
      if (
        data.type === "resize" &&
        typeof data.height === "number" &&
        Number.isFinite(data.height)
      ) {
        const height = Math.max(48, Math.ceil(data.height));
        setOverflow(height > maxHeight);
        element.style.height = `${Math.min(height, maxHeight)}px`;
      }
    };
    const loaded = () => {
      // A second load means the opaque srcdoc document navigated. Keep this
      // guard for the parent frame-src boundary; the initial about:blank load
      // cannot race because srcdoc is assigned before insertion.
      if (++loadCount > 1) {
        fail("预览试图跳转到其他页面，已停止运行。");
        return;
      }
      sendTheme();
    };
    // Start the handshake timeout as soon as the frame is mounted. The browser
    // may defer iframe visibility notifications, but it should never defer the
    // preview's readiness contract.
    timeout = setTimeout(
      () => fail("预览加载超时，请让助手简化内容后重新生成。"),
      timeoutMs,
    );
    window.addEventListener("message", onMessage);
    element.addEventListener("load", loaded);
    const observer = new MutationObserver(sendTheme);
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class", "data-theme"],
    });
    element.setAttribute("csp", INTERACTIVE_CSP);
    const state = stateKey ? readInteractiveState(stateKey) : undefined;
    element.srcdoc = interactiveDocument(html, {
      id,
      token,
      theme: currentTheme(),
      ...(locale ? { locale } : {}),
      ...(state === undefined ? {} : { state }),
    });
    container.append(element);
    return () => {
      clearTimeout(timeout);
      observer.disconnect();
      window.removeEventListener("message", onMessage);
      element.removeEventListener("load", loaded);
      element.remove();
    };
  }, [id, html, title, maxHeight, timeoutMs, stateKey, locale]);

  return (
    <div
      ref={host}
      className={className}
      data-interactive-frame=""
      data-interactive-phase={phase}
      data-interactive-overflow={overflow ? "true" : undefined}
    />
  );
}
