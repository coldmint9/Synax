import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { markdown } from "@codemirror/lang-markdown";
import { syntaxHighlighting, defaultHighlightStyle } from "@codemirror/language";
import {
  EditorState,
  RangeSetBuilder,
  type Extension,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  keymap,
  type DecorationSet,
  type ViewUpdate,
  ViewPlugin,
  WidgetType,
} from "@codemirror/view";
import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
} from "react";

export interface ComposerEditorHandle {
  dom: HTMLElement | null;
  focus: () => void;
  blur: () => void;
  getValue: () => string;
  getSelectionStart: () => number;
  setSelectionRange: (start: number, end?: number) => void;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  onInput?: (value: string, cursor: number) => void;
  onKeyDown?: (event: KeyboardEvent) => boolean | void;
  placeholder?: string;
  ariaLabel?: string;
  ariaDescribedBy?: string;
  ariaAutocomplete?: "none" | "inline" | "list" | "both";
  ariaControls?: string;
  ariaActiveDescendant?: string;
  disabled?: boolean;
  className?: string;
  minHeight?: string;
  maxHeight?: string;
}

class BulletWidget extends WidgetType {
  toDOM() {
    const element = document.createElement("span");
    element.className = "cm-composer-bullet";
    element.textContent = "•";
    return element;
  }
  ignoreEvent() {
    return true;
  }
}

const bulletWidget = Decoration.replace({ widget: new BulletWidget() });
const hidden = Decoration.replace({});
const headingLine = (level: number) =>
  Decoration.line({ class: `cm-composer-heading cm-composer-heading-${level}` });
const inlineMark = (className: string) => Decoration.mark({ class: className });

function activeLines(view: EditorView) {
  const lines = new Set<number>();
  for (const range of view.state.selection.ranges) {
    lines.add(view.state.doc.lineAt(range.from).number);
    lines.add(view.state.doc.lineAt(range.to).number);
  }
  return lines;
}

function buildDecorations(view: EditorView): DecorationSet {
  const active = activeLines(view);
  const builder = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;

  for (let number = 1; number <= doc.lines; number += 1) {
    const line = doc.line(number);
    if (active.has(number)) continue;
    const text = line.text;
    const addHidden = (from: number, to: number, replacement = hidden) => {
      if (to > from) builder.add(line.from + from, line.from + to, replacement);
    };
    const addMark = (from: number, to: number, className: string) => {
      if (to > from) builder.add(line.from + from, line.from + to, inlineMark(className));
    };

    const heading = /^(\s*)(#{1,6})(\s+)/.exec(text);
    if (heading) {
      addHidden(heading[1].length, heading[1].length + heading[2].length);
      builder.add(line.from, line.from, headingLine(heading[2].length));
    }

    const list = /^(\s*)([-*+]|\d+[.)])(\s+)/.exec(text);
    if (list) {
      addHidden(list[1].length, list[1].length + list[2].length + list[3].length, bulletWidget);
    }

    const fence = /^\s*```[^\n]*$/.exec(text);
    if (fence) addHidden(0, text.length);

    for (const match of text.matchAll(/\*\*([^*\n]+)\*\*|__([^_\n]+)__|`([^`\n]+)`/g)) {
      const full = match[0];
      const markerLength = match[3] !== undefined ? 1 : 2;
      const start = match.index ?? 0;
      addHidden(start, start + markerLength);
      addHidden(start + full.length - markerLength, start + full.length);
      addMark(start + markerLength, start + full.length - markerLength, match[3] !== undefined ? "cm-composer-code" : "cm-composer-strong");
    }

    for (const match of text.matchAll(/\[([^\]\n]+)\]\(([^)\n]+)\)/g)) {
      const start = match.index ?? 0;
      const labelStart = start + 1;
      const labelEnd = labelStart + match[1].length;
      addHidden(start, labelStart);
      addHidden(labelEnd, start + match[0].length);
      addMark(labelStart, labelEnd, "cm-composer-link");
    }
  }

  return builder.finish();
}

const markdownDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;

    constructor(view: EditorView) {
      this.decorations = buildDecorations(view);
    }

    update(update: ViewUpdate) {
      if (update.docChanged || update.selectionSet) {
        this.decorations = buildDecorations(update.view);
      }
    }
  },
  { decorations: (value) => value.decorations },
);

function composerDecorations(): Extension {
  return markdownDecorations;
}

export const ComposerMarkdownEditor = forwardRef<ComposerEditorHandle, Props>(
  function ComposerMarkdownEditor(
    {
      value,
      onChange,
      onInput,
      onKeyDown,
      placeholder,
      ariaLabel,
      ariaDescribedBy,
      ariaAutocomplete,
      ariaControls,
      ariaActiveDescendant,
      disabled = false,
      className = "",
      minHeight = "1.5rem",
      maxHeight = "12rem",
    },
    ref,
  ) {
    const hostRef = useRef<HTMLDivElement>(null);
    const viewRef = useRef<EditorView | null>(null);
    const valueRef = useRef(value);
    const onChangeRef = useRef(onChange);
    const onInputRef = useRef(onInput);
    const onKeyDownRef = useRef(onKeyDown);
    valueRef.current = value;
    onChangeRef.current = onChange;
    onInputRef.current = onInput;
    onKeyDownRef.current = onKeyDown;

    useImperativeHandle(ref, () => ({
      get dom() {
        return viewRef.current?.dom ?? null;
      },
      focus: () => viewRef.current?.focus(),
      blur: () => viewRef.current?.contentDOM.blur(),
      getValue: () => viewRef.current?.state.doc.toString() ?? valueRef.current,
      getSelectionStart: () => viewRef.current?.state.selection.main.head ?? 0,
      setSelectionRange: (start, end = start) => {
        const view = viewRef.current;
        if (!view) return;
        const from = Math.max(0, Math.min(start, view.state.doc.length));
        const to = Math.max(from, Math.min(end, view.state.doc.length));
        view.dispatch({ selection: { anchor: from, head: to }, scrollIntoView: true });
      },
    }), []);

    useEffect(() => {
      const host = hostRef.current;
      if (!host) return;

      const editor = new EditorView({
        state: EditorState.create({
          doc: value,
          extensions: [
            history(),
            keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
            markdown(),
            syntaxHighlighting(defaultHighlightStyle),
            composerDecorations(),
            EditorView.theme({
              "&": { minHeight, maxHeight, overflow: "hidden" },
              ".cm-scroller": { overflow: "auto", maxHeight },
              ".cm-content": { minHeight, padding: "0.125rem 0.125rem 0.125rem 0" },
              ".cm-line": { padding: "0", lineHeight: "1.5rem" },
              ".cm-placeholder": { color: "var(--muted-foreground)" },
            }),
            EditorView.domEventHandlers({
              keydown: (event) => onKeyDownRef.current?.(event) ?? false,
            }),
            EditorView.updateListener.of((update: ViewUpdate) => {
              if (!update.docChanged && !update.selectionSet) return;
              const next = update.state.doc.toString();
              if (update.docChanged) {
                valueRef.current = next;
                onChangeRef.current(next);
              }
              onInputRef.current?.(next, update.state.selection.main.head);
            }),
            EditorView.contentAttributes.of({
              "aria-label": ariaLabel ?? "",
            }),
            EditorView.editable.of(!disabled),
          ],
        }),
        parent: host,
      });
      viewRef.current = editor;
      editor.dispatch({ effects: [] });
      return () => {
        viewRef.current = null;
        editor.destroy();
      };
      // The editor is intentionally created once; mutable props are read through refs.
      // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    useEffect(() => {
      const view = viewRef.current;
      if (!view || view.state.doc.toString() === value) return;
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: value } });
    }, [value]);

    useEffect(() => {
      const contentDOM = viewRef.current?.contentDOM;
      if (!contentDOM) return;
      contentDOM.contentEditable = String(!disabled);
      if (placeholder) contentDOM.dataset.placeholder = placeholder;
      else delete contentDOM.dataset.placeholder;
      if (ariaLabel) contentDOM.setAttribute("aria-label", ariaLabel);
      else contentDOM.removeAttribute("aria-label");
      if (ariaDescribedBy) contentDOM.setAttribute("aria-describedby", ariaDescribedBy);
      else contentDOM.removeAttribute("aria-describedby");
      if (ariaAutocomplete) contentDOM.setAttribute("aria-autocomplete", ariaAutocomplete);
      else contentDOM.removeAttribute("aria-autocomplete");
      if (ariaControls) contentDOM.setAttribute("aria-controls", ariaControls);
      else contentDOM.removeAttribute("aria-controls");
      if (ariaActiveDescendant) contentDOM.setAttribute("aria-activedescendant", ariaActiveDescendant);
      else contentDOM.removeAttribute("aria-activedescendant");
    }, [ariaActiveDescendant, ariaAutocomplete, ariaControls, ariaDescribedBy, ariaLabel, disabled, placeholder]);

    return <div ref={hostRef} className={`composer-markdown-editor ${className}`} />;
  },
);
