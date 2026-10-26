import { lazy, Suspense } from "react";

const Editor = lazy(() => import("./MonacoTextEditorSurface"));
export interface MonacoTextEditorProps {
  path: string;
  content: string;
  onChange?: (content: string) => void;
  onDirty?: () => void;
  onSave?: () => void;
  registerFlush?: (flush: (() => void) | null) => void;
  registerFindToggle?: (toggle: (() => void) | null) => void;
  ariaLabel?: string;
  plainText?: boolean;
}
/** Shared text entry; heavy editor code stays outside the workspace startup chunk. */
export function MonacoTextEditor(props: MonacoTextEditorProps) {
  return (
    <Suspense
      fallback={
        <div className="file-viewer-status" role="status">
          加载文本编辑器…
        </div>
      }
    >
      <Editor key={props.path} {...props} />
    </Suspense>
  );
}
