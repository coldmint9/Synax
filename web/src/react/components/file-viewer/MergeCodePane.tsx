import { useEffect, useLayoutEffect, useRef } from "react";
import { Annotation, Compartment, EditorState, StateEffect, StateField, type Text } from "@codemirror/state";
import { Decoration, EditorView, WidgetType, drawSelection, keymap, lineNumbers, type DecorationSet } from "@codemirror/view";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import { HighlightStyle, LanguageDescription, syntaxHighlighting } from "@codemirror/language";
import { languages } from "@codemirror/language-data";
import { tags } from "@lezer/highlight";
import type { MergeAlignment } from "./mergeAlignment";
import { normalizeEditorText, preserveRawChanges } from "./mergeEditorText";

export const MERGE_LINE_HEIGHT = 20;
const externalChange = Annotation.define<boolean>();
const replaceDecorations = StateEffect.define<DecorationSet>();
const alignmentField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, transaction) {
    value = value.map(transaction.changes);
    for (const effect of transaction.effects) if (effect.is(replaceDecorations)) value = effect.value;
    return value;
  },
  provide: field => EditorView.decorations.from(field),
});
class AlignmentGap extends WidgetType {
  constructor(readonly rows: number) { super(); }
  eq(other: AlignmentGap) { return other.rows === this.rows; }
  get estimatedHeight() { return this.rows * MERGE_LINE_HEIGHT; }
  toDOM() {
    const element = document.createElement("div");
    element.className = "merge-alignment-gap";
    element.style.height = `${this.estimatedHeight}px`;
    element.setAttribute("aria-hidden", "true");
    return element;
  }
}
function decorations(doc: Text, gaps: MergeAlignment["gaps"][number], changedLines: number[]) {
  const ranges = gaps.map(gap => {
    const atEnd = gap.beforeLine >= doc.lines;
    return Decoration.widget({ widget: new AlignmentGap(gap.rows), block: true, side: atEnd ? 1 : -1 })
      .range(atEnd ? doc.length : doc.line(gap.beforeLine + 1).from);
  });
  for (const line of changedLines) if (line >= 0 && line < doc.lines)
    ranges.push(Decoration.line({ class: "merge-changed-line" }).range(doc.line(line + 1).from));
  return Decoration.set(ranges, true);
}
const colors = HighlightStyle.define([
  { tag: tags.keyword, color: "var(--merge-code-keyword)" },
  { tag: tags.comment, color: "var(--merge-code-comment)" },
  { tag: tags.string, color: "var(--merge-code-string)" },
  { tag: [tags.number, tags.bool, tags.null], color: "var(--merge-code-number)" },
  { tag: [tags.function(tags.variableName), tags.typeName], color: "var(--merge-code-function)" },
]);
const theme = EditorView.theme({
  "&": { height: "100%", backgroundColor: "transparent", color: "var(--ui-text)" },
  "&.cm-focused": { outline: "none" },
  ".cm-scroller": { overflow: "auto", fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace", fontSize: "12px", lineHeight: "20px" },
  ".cm-content": { padding: "0", caretColor: "var(--ui-text)" },
  ".cm-line": { padding: "0 8px", lineHeight: "20px", minHeight: "20px" },
  ".cm-gutters": { backgroundColor: "var(--ui-surface)", color: "var(--ui-subtle)", borderRight: "1px solid var(--ui-line)" },
  ".cm-lineNumbers .cm-gutterElement": { minWidth: "43px", boxSizing: "border-box", padding: "0 7px", lineHeight: "20px" },
  ".cm-cursor": { borderLeftColor: "var(--ui-text)" },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground": { backgroundColor: "var(--ui-accent-soft)" },
});
interface Props {
  text: string;
  path: string;
  label: string;
  readOnly: boolean;
  gaps: MergeAlignment["gaps"][number];
  changedLines: number[];
  onChange: (text: string) => void;
  onReady: (view: EditorView | null) => void;
  onScroll: (view: EditorView) => void;
}
export function MergeCodePane(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const latest = useRef(props); latest.current = props;
  const rawText = useRef(props.text);
  const editability = useRef(new Compartment());
  const language = useRef(new Compartment());
  const access = (readOnly: boolean, label: string) => [EditorState.readOnly.of(readOnly), EditorView.editable.of(!readOnly), EditorView.contentAttributes.of({ role: "textbox", "aria-label": label, "aria-readonly": String(readOnly), spellcheck: "false" })];
  useLayoutEffect(() => {
    const instance = new EditorView({
      parent: host.current!,
      state: EditorState.create({ doc: normalizeEditorText(latest.current.text), extensions: [
        lineNumbers(), drawSelection(), keymap.of([...defaultKeymap, indentWithTab]), theme, syntaxHighlighting(colors), alignmentField,
        editability.current.of(access(latest.current.readOnly, latest.current.label)), language.current.of([]),
        EditorView.domEventHandlers({ scroll: (_event, editor) => { latest.current.onScroll(editor); return false; } }),
        EditorView.updateListener.of(update => {
          if (!update.docChanged || update.transactions.some(transaction => transaction.annotation(externalChange))) return;
          rawText.current = preserveRawChanges(rawText.current, update.changes);
          latest.current.onChange(rawText.current);
        }),
      ] }),
    });
    view.current = instance; latest.current.onReady(instance);
    return () => { latest.current.onReady(null); instance.destroy(); view.current = null; };
  }, []);
  useLayoutEffect(() => {
    const editor = view.current;
    if (!editor) return;
    const text = normalizeEditorText(props.text);
    const changed = editor.state.doc.toString() !== text;
    rawText.current = props.text;
    const changes = changed ? { from: 0, to: editor.state.doc.length, insert: text } : undefined;
    const nextDoc = changed ? EditorState.create({ doc: text }).doc : editor.state.doc;
    editor.dispatch({ changes, annotations: externalChange.of(true), effects: [
      replaceDecorations.of(decorations(nextDoc, props.gaps, props.changedLines)),
      editability.current.reconfigure(access(props.readOnly, props.label)),
    ] });
  }, [props.text, props.gaps, props.changedLines, props.readOnly, props.label]);
  useEffect(() => {
    let active = true;
    const description = LanguageDescription.matchFilename(languages, props.path);
    if (description) void description.load().then(support => { if (active) view.current?.dispatch({ effects: language.current.reconfigure(support) }); }).catch(() => {});
    else view.current?.dispatch({ effects: language.current.reconfigure([]) });
    return () => { active = false; };
  }, [props.path]);
  return <div className="merge-codemirror" ref={host} />;
}
