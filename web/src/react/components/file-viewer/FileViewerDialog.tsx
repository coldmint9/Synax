import { FileViewer } from "./FileViewer";
import type { MergeFileViewerProps } from "./MergeFileViewer";

export type FileViewerDialogProps = MergeFileViewerProps;
/** MR adapter: the shared FileViewer owns merge presentation and interaction. */
export function FileViewerDialog(props: FileViewerDialogProps) {
  return <FileViewer key={props.file.id} mode="merge" {...props} />;
}
