import { useEffect, useState } from "react";
import type {
  ArtifactFile,
  ArtifactRevision,
} from "../../../../../api/services/agent-runtime/artifacts/contracts";
import { artifactsApi } from "../../../lib/api/artifacts";
import { sourceDiff } from "./source-diff";
import { artifactText } from "./locale";
interface ArtifactSourcePaneProps {
  uid: string;
  locale: string;
  sessionId: string;
  revisionId: string;
  revisions: ArtifactRevision[];
  compareId: string;
  reload: number;
  onCompareChange: (revisionId: string) => void;
}
export function ArtifactSourcePane({
  uid,
  locale,
  sessionId,
  revisionId,
  revisions,
  compareId,
  reload,
  onCompareChange,
}: ArtifactSourcePaneProps) {
  const translate = (text: string) => artifactText(locale, text);
  const [files, setFiles] = useState<ArtifactFile[] | null>(null);
  const [compareFiles, setCompareFiles] = useState<ArtifactFile[] | null>(null);
  const [sourceError, setSourceError] = useState("");
  useEffect(() => {
    let current = true;
    setFiles(null);
    setCompareFiles(null);
    setSourceError("");
    Promise.all([
      artifactsApi.source(sessionId, revisionId),
      compareId
        ? artifactsApi.source(sessionId, compareId)
        : Promise.resolve(null),
    ])
      .then(([source, comparison]) => {
        if (current) {
          setFiles(source.files);
          setCompareFiles(comparison?.files ?? null);
        }
      })
      .catch((error) => {
        if (current)
          setSourceError(
            error instanceof Error
              ? error.message
              : "Artifact source request failed.",
          );
      });
    return () => {
      current = false;
    };
  }, [revisionId, compareId, sessionId, reload]);
  return (
    <div
      className="artifact-source"
      role="tabpanel"
      id={`${uid}-source-panel`}
      aria-labelledby={`${uid}-source`}
    >
      <label className="artifact-compare">
        {translate("Compare with")}{" "}
        <select
          aria-label={translate("Compare version")}
          value={compareId}
          onChange={(e) => onCompareChange(e.target.value)}
        >
          <option value="">{translate("No comparison")}</option>
          {revisions
            .filter((item) => item.revisionId !== revisionId)
            .map((item) => (
              <option key={item.revisionId} value={item.revisionId}>
                v{item.revisionNumber}
              </option>
            ))}
        </select>
      </label>
      {sourceError ? (
        <p role="alert">{sourceError}</p>
      ) : !files ? (
        <p role="status">{translate("Loading source…")}</p>
      ) : files.length === 0 ? (
        <p>{translate("No source files in this revision.")}</p>
      ) : (
        sourceDiff(compareFiles ?? [], files).map((change) => (
          <details key={change.path} open={files.length === 1}>
            <summary>
              {change.path}
              {compareFiles && (
                <span className="artifact-badge">{change.status}</span>
              )}
            </summary>
            <div className={compareFiles ? "artifact-source-columns" : ""}>
              {compareFiles && (
                <SourceFile
                  file={change.before}
                  label={translate("Previous")}
                />
              )}
              <SourceFile
                file={change.after}
                label={
                  compareFiles
                    ? translate("Selected revision")
                    : translate("Source")
                }
              />
            </div>
          </details>
        ))
      )}
    </div>
  );
}
function SourceFile({ file, label }: { file?: ArtifactFile; label: string }) {
  return (
    <div>
      <span className="artifact-source-label">{label}</span>
      <pre>
        {!file
          ? "(File not present)"
          : file.encoding === "base64"
            ? `Binary asset · ${file.mediaType} · export the source archive to inspect`
            : file.content.length > 200000
              ? `${file.content.slice(0, 200000)}\n\n[Preview truncated at 200,000 characters. Export for complete source.]`
              : file.content}
      </pre>
    </div>
  );
}
