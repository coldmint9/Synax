import {
  MonacoTextEditor,
  type MonacoTextEditorProps,
} from "./MonacoTextEditor";

/** Presentation only: callers own loading, revisions, persistence and drafts. */
export function TextFileContent(
  props: MonacoTextEditorProps & { html?: string },
) {
  return <MonacoTextEditor {...props} />;
}
