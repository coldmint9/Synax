import { useLayoutEffect, useRef, useState } from "react";
import { optimizeInput } from "../../../adapters/transport/inputOptimization";
import { useLocale } from "../../../shared/hooks/useLocale";

export const INPUT_OPTIMIZATION_TIMEOUT_MS = 60_000;

interface Options {
  scope: string;
  projectId: string;
  content: string;
  model?: string;
  backendId?: string;
  onContentChange: (text: string) => void;
}
interface UndoSnapshot {
  original: string;
  optimized: string;
}

export function useInputOptimization(options: Options) {
  const { locale } = useLocale();
  const zh = locale === "zh";
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<UndoSnapshot | null>(null);
  const request = useRef<AbortController | null>(null);
  const current = useRef(options);

  useLayoutEffect(() => {
    const previous = current.current;
    current.current = options;
    if (
      previous.scope !== options.scope ||
      previous.content !== options.content
    ) {
      const wasPending = Boolean(request.current);
      request.current?.abort();
      request.current = null;
      setPending(false);
      setError(null);
      if (previous.scope !== options.scope) {
        setSnapshot(null);
        setNotice(null);
      } else {
        setSnapshot((value) =>
          value?.optimized === options.content ? value : null,
        );
        setNotice(
          wasPending
            ? zh
              ? "输入已修改，已取消优化。"
              : "Input changed; optimization cancelled."
            : null,
        );
      }
    }
  });

  useLayoutEffect(
    () => () => {
      request.current?.abort();
      request.current = null;
    },
    [],
  );

  const optimize = async () => {
    if (request.current || !current.current.content.trim()) return;
    const initial = current.current;
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(INPUT_OPTIMIZATION_TIMEOUT_MS),
    ]);
    request.current = controller;
    setPending(true);
    setError(null);
    setNotice(null);
    try {
      const result = await optimizeInput(
        {
          projectId: initial.projectId,
          text: initial.content,
          model: initial.model,
          backendId: initial.backendId,
        },
        signal,
      );
      if (request.current !== controller || controller.signal.aborted) return;
      signal.throwIfAborted();
      // Clear the in-flight request before updating the draft: our own edit is not cancellation.
      request.current = null;
      setPending(false);
      if (result.status === "preserved") {
        setNotice(
          zh
            ? "优化结果未能保留原意，已保留原文。可重试或更换输入优化模型。"
            : "The rewrite did not preserve your draft. The original was kept. Retry or choose another input optimization model.",
        );
        return;
      }
      if (result.status === "unchanged" || result.text === initial.content) {
        setNotice(zh ? "输入已清晰，无需修改。" : "Your draft is already clear; no changes needed.");
        return;
      }
      setSnapshot({ original: initial.content, optimized: result.text });
      current.current.onContentChange(result.text);
    } catch (err) {
      if (request.current === controller && !controller.signal.aborted) {
        setError(
          signal.aborted && signal.reason?.name === "TimeoutError"
            ? zh
              ? "输入优化超时，原文已保留，请重试。"
              : "Input optimization timed out. Your draft was kept; please retry."
            : err instanceof Error ? err.message : String(err),
        );
      }
    } finally {
      if (request.current === controller) {
        request.current = null;
        setPending(false);
      }
    }
  };

  const canUndo = Boolean(
    snapshot && snapshot.optimized === options.content && !pending,
  );
  const undo = () => {
    if (!snapshot || !canUndo) return;
    options.onContentChange(snapshot.original);
    setSnapshot(null);
    setError(null);
    setNotice(null);
  };
  return { optimize, undo, canUndo, pending, error, notice };
}
