import { useLayoutEffect, useRef, useState } from "react";
import { optimizeInput } from "../../../../lib/api/inputOptimization";
import { useLocale } from "../../../../hooks/useLocale";

export const INPUT_OPTIMIZATION_TIMEOUT_MS = 20_000;

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
        AbortSignal.any([
          controller.signal,
          AbortSignal.timeout(INPUT_OPTIMIZATION_TIMEOUT_MS),
        ]),
      );
      if (request.current !== controller || controller.signal.aborted) return;
      // Clear the in-flight request before updating the draft: our own edit is not cancellation.
      request.current = null;
      setPending(false);
      setSnapshot({ original: initial.content, optimized: result.text });
      current.current.onContentChange(result.text);
    } catch (err) {
      if (request.current === controller && !controller.signal.aborted)
        setError(err instanceof Error ? err.message : String(err));
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
