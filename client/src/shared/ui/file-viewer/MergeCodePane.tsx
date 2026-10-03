import { useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { MergeAlignment } from "./mergeAlignment";
import { normalizeEditorText, restoreLineEndings } from "./mergeEditorText";

/** Vertical rhythm shared with the gutter and the conflict block rail. */
export const MERGE_LINE_HEIGHT = 20;

export interface MergePaneHandle {
  /** The element that owns scrolling; scrollTop/scrollLeft drive cross-pane sync. */
  scrollDOM: HTMLElement;
  setSelection: (anchor: number, head: number) => void;
  focus: () => void;
}

const KEYWORDS = new Set([
  "abstract", "any", "as", "async", "await", "bool", "break", "case", "catch", "class",
  "const", "constructor", "continue", "def", "default", "defer", "delete", "do", "elif",
  "else", "enum", "except", "export", "extends", "false", "final", "finally", "fn", "for",
  "from", "func", "function", "if", "impl", "implements", "import", "in", "instanceof",
  "interface", "is", "lambda", "let", "loop", "match", "mut", "new", "nil", "none", "null",
  "of", "package", "pass", "private", "protected", "pub", "public", "raise", "readonly",
  "return", "self", "static", "struct", "super", "switch", "this", "throw", "trait", "true",
  "try", "type", "typeof", "undefined", "use", "var", "void", "where", "while", "with",
  "yield",
]);

const TOKEN_PATTERN =
  /(\/\/[^\n]*|\/\*[\s\S]*?\*\/)|("(?:[^"\\\n]|\\.)*"|'(?:[^'\\\n]|\\.)*'|`(?:[^`\\]|\\.)*`)|\b(\d[\w.]*)\b|([A-Za-z_$][\w$]*)/g;

const TOKEN_COLOR: Record<string, string | undefined> = {
  comment: "var(--merge-code-comment)",
  string: "var(--merge-code-string)",
  number: "var(--merge-code-number)",
  keyword: "var(--merge-code-keyword)",
  function: "var(--merge-code-function)",
  plain: undefined,
};

/** Conservative single-line tokenizer: unknown syntax stays plain instead of guessing. */
function highlight(line: string): ReactNode[] {
  if (line.trimStart().startsWith("#")) return [line];
  const nodes: ReactNode[] = [];
  let cursor = 0;
  for (const match of line.matchAll(TOKEN_PATTERN)) {
    const at = match.index ?? 0;
    if (at > cursor) nodes.push(line.slice(cursor, at));
    const [text, comment, string, number, identifier] = match;
    let kind = "plain";
    if (comment) kind = "comment";
    else if (string) kind = "string";
    else if (number) kind = "number";
    else if (identifier)
      kind = KEYWORDS.has(identifier)
        ? "keyword"
        : /^\s*\(/.test(line.slice(at + text.length))
          ? "function"
          : "plain";
    if (kind === "plain") nodes.push(text);
    else
      nodes.push(
        <span key={`${at}-${kind}`} style={{ color: TOKEN_COLOR[kind] }}>
          {text}
        </span>,
      );
    cursor = at + text.length;
  }
  if (cursor < line.length) nodes.push(line.slice(cursor));
  return nodes;
}

interface Props {
  text: string;
  label: string;
  readOnly: boolean;
  gaps: MergeAlignment["gaps"][number];
  changedLines: number[];
  onChange: (text: string) => void;
  onReady: (pane: MergePaneHandle | null) => void;
  onScroll: (pane: MergePaneHandle) => void;
}

interface Row {
  key: string;
  gap?: number;
  line?: number;
  changed?: boolean;
}

/**
 * One merge pane: a native textarea owns scrolling and editing while a painted
 * layer renders highlighting, alignment gaps and changed-line bands. Both layers
 * share `MERGE_LINE_HEIGHT` so the three panes stay row-aligned while scrolling.
 */
export function MergeCodePane(props: Props) {
  const latest = useRef(props);
  latest.current = props;
  const input = useRef<HTMLTextAreaElement | null>(null);
  const rawText = useRef(props.text);
  const [offset, setOffset] = useState({ top: 0, left: 0 });
  const handle = useMemo<MergePaneHandle>(
    () => ({
      get scrollDOM() {
        return input.current as HTMLElement;
      },
      setSelection: (anchor, head) => {
        input.current?.setSelectionRange(Math.min(anchor, head), Math.max(anchor, head));
      },
      focus: () => input.current?.focus(),
    }),
    [],
  );

  useLayoutEffect(() => {
    latest.current.onReady(handle);
    return () => latest.current.onReady(null);
  }, [handle]);

  const normalized = normalizeEditorText(props.text);
  useLayoutEffect(() => {
    rawText.current = props.text;
    const element = input.current;
    if (element && element.value !== normalized) element.value = normalized;
  }, [props.text, normalized]);

  const lines = useMemo(() => normalized.split("\n"), [normalized]);
  const rows = useMemo<Row[]>(() => {
    const gapRows = new Map<number, number>();
    for (const gap of props.gaps)
      gapRows.set(gap.beforeLine, (gapRows.get(gap.beforeLine) ?? 0) + gap.rows);
    const changed = new Set(props.changedLines);
    const built: Row[] = [];
    for (let line = 0; line < lines.length; line++) {
      const gap = gapRows.get(line);
      if (gap) built.push({ key: `gap-${line}`, gap });
      built.push({ key: `line-${line}`, line, changed: changed.has(line) });
    }
    const tail = gapRows.get(lines.length);
    if (tail) built.push({ key: `gap-${lines.length}`, gap: tail });
    return built;
  }, [lines, props.gaps, props.changedLines]);

  return (
    <>
      <div className="merge-code-gutter" aria-hidden="true">
        <div
          className="merge-code-gutter-inner"
          style={{ transform: `translateY(${-offset.top}px)` }}
        >
          {rows.map((row) =>
            row.gap ? (
              <div
                key={row.key}
                className="merge-alignment-gap"
                style={{ height: row.gap * MERGE_LINE_HEIGHT }}
              />
            ) : (
              <div key={row.key} className="merge-code-lineno">
                {row.line! + 1}
              </div>
            ),
          )}
        </div>
      </div>
      <div className="merge-code-overlay" aria-hidden="true">
        <div
          className="merge-code-paint"
          style={{ transform: `translate(${-offset.left}px, ${-offset.top}px)` }}
        >
          {rows.map((row) =>
            row.gap ? (
              <div
                key={row.key}
                className="merge-alignment-gap"
                style={{ height: row.gap * MERGE_LINE_HEIGHT }}
              />
            ) : (
              <div
                key={row.key}
                className={`merge-code-line${row.changed ? " merge-changed-line" : ""}`}
              >
                {highlight(lines[row.line!])}
              </div>
            ),
          )}
        </div>
      </div>
      <textarea
        className="merge-code-input"
        ref={input}
        defaultValue={normalized}
        readOnly={props.readOnly}
        aria-label={props.label}
        aria-readonly={props.readOnly}
        spellCheck={false}
        wrap="off"
        onChange={(event) => {
          rawText.current = restoreLineEndings(rawText.current, event.currentTarget.value);
          latest.current.onChange(rawText.current);
        }}
        onScroll={(event) => {
          const element = event.currentTarget;
          setOffset((previous) =>
            previous.top === element.scrollTop && previous.left === element.scrollLeft
              ? previous
              : { top: element.scrollTop, left: element.scrollLeft },
          );
          latest.current.onScroll(handle);
        }}
      />
    </>
  );
}
