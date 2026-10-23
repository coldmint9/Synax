import { lazy, Suspense } from "react";
import type { ReactNode } from "react";
import type { ReadMergeDocumentSlice } from "./LargeMergeFileViewer";
import type {
  MergeFile,
  MergeFileSave,
} from "../../../../../services/local-node/modules/git-mr/contracts";
import { Dialog, DialogPanel, DialogTitle } from "../ui/Dialog";
import "./fileViewer.css";

const MonacoMergeWorkbench = lazy(() => import("./MonacoMergeWorkbench"));
const LargeMergeFileViewer = lazy(() => import("./LargeMergeFileViewer"));

export interface MergeFileViewerProps {
  file: MergeFile;
  onSave: (input: MergeFileSave) => Promise<void | { revision: string }>;
  onClose: () => void;
  readOnly?: boolean;
  /** Task controls are shared with the owning card; viewing never starts a run. */
  controls?: ReactNode;
  managed?: boolean;
  registerDraftFlush?: (flush: (() => Promise<boolean>) | null) => void;
  readSlice?: ReadMergeDocumentSlice;
}

/** Monaco is loaded only when a conflict file is actually opened. */
export function MergeFileViewer(props: MergeFileViewerProps) {
  const partial = props.file.contentState === "partial";
  const viewerProps = {
    ...props,
    readOnly: props.readOnly || props.file.editable === false,
  };
  return (
    <Suspense
      fallback={
        <Dialog open onClose={props.onClose}>
          <DialogPanel className="shared-file-dialog idea-merge-dialog">
            <header className="shared-file-header">
              <DialogTitle>{props.file.path}</DialogTitle>
              <button onClick={props.onClose} aria-label="关闭合并编辑器">
                关闭
              </button>
            </header>
            <p role="status">正在加载合并编辑器…</p>
          </DialogPanel>
        </Dialog>
      }
    >
      {partial ? (
        <LargeMergeFileViewer key={props.file.id} {...viewerProps} />
      ) : (
        <MonacoMergeWorkbench key={props.file.id} {...viewerProps} />
      )}
    </Suspense>
  );
}
