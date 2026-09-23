import { MergeFileViewer, type MergeFileViewerProps } from "./MergeFileViewer";
import { TextFileContent } from "./TextFileContent";
import { UnifiedDiffContent, type ParsedDiff } from "./UnifiedDiffContent";

/** Shared presentation boundary; session/MR adapters own their APIs. */
export type FileViewerProps =
  | {
      mode: "text";
      path: string;
      content: string;
      html?: string;
      onChange?: (value: string) => void;
    }
  | { mode: "diff"; parsed: ParsedDiff; lineHtml: Record<string, string> }
  | ({ mode: "merge" } & MergeFileViewerProps);
export function FileViewer(props: FileViewerProps) {
  if (props.mode === "merge") return <MergeFileViewer {...props} />;
  return props.mode === "text" ? (
    <TextFileContent {...props} />
  ) : (
    <UnifiedDiffContent {...props} />
  );
}
