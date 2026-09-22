import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";
import { accentPalette, type ResolvedTheme } from "../../../lib/appearance";
import { TerminalConnection } from "../../../lib/api/terminalConnection";
import { type TerminalSession } from "../../../lib/api/terminal";
import { useShellStore } from "../../state/shellStore";
import { useLocale } from "../../../hooks/useLocale";
import { terminalChanged, useTerminalStore } from "./terminalStore";
import { TerminalOutputBuffer } from "./terminalOutputBuffer";
import { enableWebglRenderer } from "./terminalRenderer";

const themes = {
  dark: {
    background: "#141618",
    foreground: "#e4e7eb",
    black: "#202226",
    brightBlack: "#7b818a",
  },
  light: {
    background: "#fafbfc",
    foreground: "#263238",
    black: "#263238",
    brightBlack: "#68737d",
  },
};
function terminalTheme(theme: ResolvedTheme, accent: string) {
  const palette = accentPalette(accent, theme);
  return {
    ...themes[theme],
    cursor: palette.strong,
    selectionBackground: palette.soft,
  };
}

export function TerminalViewport({
  session,
  visible,
}: {
  session: TerminalSession;
  visible: boolean;
}) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const theme = useShellStore((state) => state.resolvedTheme);
  const accent = useShellStore((state) => state.preferences.accentColor);
  const host = useRef<HTMLDivElement>(null);
  const instance = useRef<{
    terminal: Terminal;
    fit: FitAddon;
    fitNow: () => void;
    syncInput: () => void;
    setVisible: (visible: boolean) => void;
  } | null>(null);
  const visibleRef = useRef(visible);
  visibleRef.current = visible;
  const endedRef = useRef(session.state === "closed");
  endedRef.current = session.state === "closed";
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    if (!host.current) return;
    let disposed = false,
      connected = false,
      replaying = false,
      stopped = session.state === "closed";
    let resizeTimer: ReturnType<typeof setTimeout> | undefined;
    const desktop = (
      window as Window & {
        electronAPI?: {
          getAccessibilitySupportEnabled?: () => Promise<boolean>;
          onAccessibilitySupportChanged?: (
            callback: (enabled: boolean) => void,
          ) => () => void;
        };
      }
    ).electronAPI;
    const terminal = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: '"SFMono-Regular", Menlo, Consolas, monospace',
      scrollback: 5000,
      // Desktop can query the OS and enable the full accessibility tree only
      // when assistive technology is active. Browsers retain xterm's a11y path.
      screenReaderMode: !desktop?.getAccessibilitySupportEnabled,
      theme: terminalTheme(
        useShellStore.getState().resolvedTheme,
        useShellStore.getState().preferences.accentColor,
      ),
      allowProposedApi: false,
      disableStdin: true,
      linkHandler: {
        activate: (event, uri) => {
          if (!(event.ctrlKey || event.metaKey)) return;
          try {
            const url = new URL(uri);
            if (["http:", "https:"].includes(url.protocol))
              window.open(url.href, "_blank", "noopener,noreferrer");
          } catch {}
        },
      },
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.open(host.current);
    const terminalHost = host.current;
    enableWebglRenderer(terminal, (renderer) => {
      terminalHost.dataset.renderer = renderer;
    });
    const setAccessibility = (enabled: boolean) => {
      if (!disposed) terminal.options.screenReaderMode = enabled;
    };
    void desktop
      ?.getAccessibilitySupportEnabled?.()
      .then(setAccessibility)
      .catch(() => {});
    const removeAccessibilityListener =
      desktop?.onAccessibilitySupportChanged?.(setAccessibility);
    if (terminal.textarea)
      terminal.textarea.setAttribute(
        "aria-label",
        zh ? "终端输入" : "Terminal input",
      );
    const syncInput = () => {
      terminal.options.disableStdin =
        !connected || stopped || endedRef.current || replaying;
    };
    const fitNow = () => {
      if (disposed || !host.current?.clientWidth || !host.current.clientHeight)
        return;
      fit.fit();
      syncInput();
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        if (!stopped && !disposed)
          source.resize(
            Math.min(500, terminal.cols),
            Math.min(300, terminal.rows),
          );
      }, 80);
    };
    let ackTimer: ReturnType<typeof setTimeout> | undefined,
      ackSequence = 0;
    const ack = (sequence: number) => {
      ackSequence = Math.max(ackSequence, sequence);
      if (ackTimer || disposed || stopped) return;
      ackTimer = setTimeout(() => {
        ackTimer = undefined;
        if (!disposed && !stopped) source.acknowledge(ackSequence);
      }, 24);
    };
    const output = new TerminalOutputBuffer(
      (data, callback) => terminal.write(data, callback),
      ack,
    );
    const source = new TerminalConnection(
      session,
      {
        connected: () => {
          if (!disposed) {
            connected = true;
            syncInput();
            fitNow();
          }
        },
        disconnected: () => {
          if (!disposed) {
            connected = false;
            syncInput();
          }
        },
        error: (message) => {
          if (!disposed) setError(message);
        },
        reset: (data, sequence, clear) => {
          if (disposed) return;
          // Replaying an old vi/SSH query must never send its response into the
          // current shell. Only live output may generate terminal protocol replies.
          replaying = true;
          syncInput();
          if (clear) terminal.reset();
          terminal.write(data, () => {
            replaying = false;
            if (!disposed) {
              syncInput();
              if (!stopped) {
                source.redraw();
              }
              ack(sequence);
            }
          });
        },
        data: (data, sequence) => {
          if (!disposed) output.push(data, sequence);
        },
        state: (item) => {
          if (disposed) return;
          useTerminalStore.getState().update(item);
          stopped = item.state === "closed" || item.state === "unconfirmed";
          syncInput();
          if (stopped) {
            source.close();
            terminalChanged();
          }
        },
      },
      visibleRef.current,
    );
    let viewVisible = visibleRef.current;
    const setVisible = (nextVisible: boolean) => {
      if (nextVisible === viewVisible) {
        if (nextVisible) {
          fitNow();
          terminal.focus();
        }
        return;
      }
      viewVisible = nextVisible;
      if (nextVisible) {
        source.resume();
        fitNow();
        terminal.focus();
      } else {
        connected = false;
        source.pause();
        syncInput();
      }
    };
    instance.current = {
      terminal,
      fit,
      fitNow,
      syncInput,
      setVisible,
    };
    const input = (data: string, binary = false) => {
      if (disposed || !connected || stopped || replaying) return;
      if (data.length > 256 * 1024) {
        setError(
          zh
            ? "粘贴内容过大，请改用文件。"
            : "Paste is too large; use a file instead.",
        );
        return;
      }
      try {
        source.prepareInput(data);
        for (let offset = 0; offset < data.length; ) {
          let end = Math.min(data.length, offset + 16000);
          const code = data.charCodeAt(end - 1);
          if (!binary && end < data.length && code >= 0xd800 && code <= 0xdbff)
            end--;
          source.write(data.slice(offset, end), binary);
          offset = end;
        }
      } catch (error) {
        setError(error instanceof Error ? error.message : String(error));
      }
    };
    const onData = terminal.onData((data) => input(data));
    const onBinary = terminal.onBinary((data) => input(data, true));
    terminal.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      const mac = navigator.platform.includes("Mac");
      const appShortcut = mac ? event.metaKey : event.ctrlKey && event.shiftKey;
      const command = mac ? event.metaKey : event.ctrlKey;
      if (appShortcut && event.key.toLowerCase() === "j") {
        event.preventDefault();
        useTerminalStore.getState().toggle();
        return false;
      }
      if (command && event.shiftKey && event.key.toLowerCase() === "t") {
        event.preventDefault();
        document.dispatchEvent(new CustomEvent("terminal:new"));
        return false;
      }
      if (event.metaKey && event.key.toLowerCase() === "w") {
        event.preventDefault();
        useTerminalStore.getState().closeTab(session.id);
        return false;
      }
      if (event.metaKey && event.key.toLowerCase() === "k") {
        event.preventDefault();
        terminal.clear();
        return false;
      }
      if (
        command &&
        event.key.toLowerCase() === "c" &&
        terminal.hasSelection()
      ) {
        void navigator.clipboard
          .writeText(terminal.getSelection())
          .catch(() =>
            setError(zh ? "无法复制到剪贴板" : "Clipboard unavailable"),
          );
        return false;
      }
      if (event.metaKey && event.key.toLowerCase() === "a") {
        terminal.selectAll();
        return false;
      }
      // Clipboard paste/IME, Ctrl+C/R/Z, arrows and bracketed paste stay with xterm.
      return true;
    });
    const observer = new ResizeObserver(fitNow);
    observer.observe(host.current);
    fitNow();
    if (visibleRef.current) terminal.focus();
    return () => {
      disposed = true;
      clearTimeout(resizeTimer);
      clearTimeout(ackTimer);
      output.dispose();
      removeAccessibilityListener?.();
      source.close();
      observer.disconnect();
      onData.dispose();
      onBinary.dispose();
      terminal.dispose();
      instance.current = null;
    };
  }, [session.id]);
  useEffect(() => {
    if (instance.current)
      instance.current.terminal.options.theme = terminalTheme(theme, accent);
  }, [theme, accent]);
  useLayoutEffect(() => {
    instance.current?.syncInput();
    instance.current?.setVisible(visible);
  }, [visible, session.state]);
  return (
    <div
      className="terminal-screen"
      hidden={!visible}
      inert={!visible}
      data-terminal-id={session.id}
    >
      {error && (
        <div className="terminal-error" role="alert">
          {error}
          <button
            type="button"
            aria-label={zh ? "关闭错误" : "Dismiss error"}
            onClick={() => setError(null)}
          >
            ×
          </button>
        </div>
      )}
      <div
        ref={host}
        className="terminal-emulator"
        aria-label={zh ? "交互式终端" : "Interactive terminal"}
      />
    </div>
  );
}
