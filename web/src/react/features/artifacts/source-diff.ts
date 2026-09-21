import type { ArtifactFile } from "../../../../../api/services/agent-runtime/artifacts/contracts";
export interface SourceChange {
  path: string;
  status: "added" | "removed" | "changed" | "unchanged";
  before?: ArtifactFile;
  after?: ArtifactFile;
}
/** Bounded file-level diff; side-by-side full content avoids quadratic line LCS on
 * adversarial multi-megabyte single lines. Binary content is never decoded in DOM. */
export function sourceDiff(
  before: ArtifactFile[],
  after: ArtifactFile[],
): SourceChange[] {
  const previous = new Map(before.map((file) => [file.path, file]));
  const current = new Map(after.map((file) => [file.path, file]));
  return [...new Set([...previous.keys(), ...current.keys()])]
    .sort()
    .map((path) => {
      const a = previous.get(path),
        b = current.get(path);
      return {
        path,
        status: !a
          ? "added"
          : !b
            ? "removed"
            : a.content === b.content && a.encoding === b.encoding
              ? "unchanged"
              : "changed",
        before: a,
        after: b,
      };
    });
}
