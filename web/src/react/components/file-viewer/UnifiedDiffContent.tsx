import { parsePatch } from "diff";
import { highlightLines } from "../../features/agent-workspace/codeHighlight";

type DiffLineType = "file" | "hunk" | "add" | "del" | "ctx" | "meta" | "raw";

interface DiffLine {
  key: string;
  type: DiffLineType;
  oldLine: string;
  newLine: string;
  text: string;
}

export interface ParsedDiff {
  lines: DiffLine[];
  /** Rows per hunk: each side is highlighted as one contiguous block so
   *  multi-line constructs still tokenize the way an editor would. */
  hunks: DiffLine[][];
}

function marker(type: DiffLineType): string {
  if (type === "add") return "+";
  if (type === "del") return "-";
  return "";
}

/**
 * `a/src/x.ts` / `b/src/x.ts` both name the same file, so both collapse to the
 * bare path. `/dev/null` means "no file on this side" and becomes an empty
 * string, which callers read as a whole-file add or delete.
 */
function cleanPath(name: string): string {
  if (!name || name === "/dev/null") return "";
  return name.replace(/^[ab]\//, "");
}

export function renderLines(raw: string): ParsedDiff {
  const lines: DiffLine[] = [];
  const hunks: DiffLine[][] = [];
  let seq = 0;
  const nextKey = () => `diff-${seq++}`;

  if (!raw.trim()) return { lines, hunks };

  try {
    const files = parsePatch(raw);
    for (const file of files) {
      const oldName = cleanPath(file.oldFileName ?? "");
      const newName = cleanPath(file.newFileName ?? "");
      // The panel header already names the file, and an untracked/deleted file
      // is obvious from its all-green/all-red rows, so the band is only worth a
      // row for a rename — where the two paths are the actual news.
      const renamed = Boolean(oldName && newName) && oldName !== newName;
      if (renamed) {
        lines.push({
          key: nextKey(),
          type: "file",
          oldLine: "",
          newLine: "",
          text: `${oldName} → ${newName}`,
        });
      }

      for (const hunk of file.hunks) {
        const group: DiffLine[] = [];
        const push = (line: DiffLine) => {
          lines.push(line);
          group.push(line);
        };
        push({
          key: nextKey(),
          type: "hunk",
          oldLine: "",
          newLine: "",
          text: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
        });

        let oldLine = hunk.oldStart;
        let newLine = hunk.newStart;
        for (const rawLine of hunk.lines) {
          const prefix = rawLine.slice(0, 1);
          const text = rawLine.slice(1);
          if (prefix === "+") {
            push({
              key: nextKey(),
              type: "add",
              oldLine: "",
              newLine: String(newLine),
              text,
            });
            newLine += 1;
          } else if (prefix === "-") {
            push({
              key: nextKey(),
              type: "del",
              oldLine: String(oldLine),
              newLine: "",
              text,
            });
            oldLine += 1;
          } else if (prefix === " ") {
            push({
              key: nextKey(),
              type: "ctx",
              oldLine: String(oldLine),
              newLine: String(newLine),
              text,
            });
            oldLine += 1;
            newLine += 1;
          } else {
            push({
              key: nextKey(),
              type: "meta",
              oldLine: "",
              newLine: "",
              text: rawLine,
            });
          }
        }

        // A hunk always carries at least one side's lines; skip the empty ones.
        if (group.length > 1) hunks.push(group);
      }
    }
  } catch {
    lines.push({
      key: nextKey(),
      type: "raw",
      oldLine: "",
      newLine: "",
      text: raw,
    });
  }

  // `parsePatch` happily returns an empty file list for text that is not a
  // patch at all (mode-only changes land here too). Show the payload verbatim
  // rather than pretending the file has no differences.
  const hasCodeRows = lines.some(
    (line) => line.type === "add" || line.type === "del" || line.type === "ctx",
  );
  if (!hasCodeRows && raw.trim()) {
    return {
      lines: [
        { key: nextKey(), type: "raw", oldLine: "", newLine: "", text: raw },
      ],
      hunks: [],
    };
  }

  return { lines, hunks };
}

/**
 * Highlight both sides of every hunk.
 *
 * Deleted and context rows come from the old file, added and context rows from
 * the new one, so each side is highlighted as its own contiguous block and the
 * resulting line fragments are mapped back onto the rows by key.
 */
export async function highlightHunks(
  hunks: DiffLine[][],
  path: string,
): Promise<Record<string, string>> {
  const html: Record<string, string> = {};
  await Promise.all(
    hunks.map(async (group) => {
      const oldRows = group.filter(
        (line) => line.type === "del" || line.type === "ctx",
      );
      const newRows = group.filter(
        (line) => line.type === "add" || line.type === "ctx",
      );
      const [oldHtml, newHtml] = await Promise.all([
        oldRows.length
          ? highlightLines(oldRows.map((line) => line.text).join("\n"), path)
          : [],
        newRows.length
          ? highlightLines(newRows.map((line) => line.text).join("\n"), path)
          : [],
      ]);
      // Context rows exist on both sides; the new side wins, the text is identical.
      oldRows.forEach((row, index) => {
        if (oldHtml[index] !== undefined) html[row.key] = oldHtml[index];
      });
      newRows.forEach((row, index) => {
        if (newHtml[index] !== undefined) html[row.key] = newHtml[index];
      });
    }),
  );
  return html;
}

/** One table row: a full-width band for file/hunk/meta rows, a line row otherwise. */
function DiffRow({ line, html }: { line: DiffLine; html?: string }) {
  if (line.type === "file" || line.type === "hunk" || line.type === "meta") {
    return (
      <tr className={`diff-row diff-row--${line.type}`}>
        <td className={`diff-band diff-band--${line.type}`} colSpan={4}>
          {line.text}
        </td>
      </tr>
    );
  }
  if (line.type === "raw") {
    return (
      <tr className="diff-row diff-row--raw">
        <td className="diff-raw" colSpan={4}>
          {line.text}
        </td>
      </tr>
    );
  }
  return (
    <tr className={`diff-row diff-row--${line.type}`}>
      <td className="diff-num diff-num--old">{line.oldLine}</td>
      <td className="diff-num diff-num--new">{line.newLine}</td>
      <td className="diff-marker">{marker(line.type)}</td>
      <td className="diff-text">
        {html !== undefined ? (
          <span dangerouslySetInnerHTML={{ __html: html }} />
        ) : (
          line.text
        )}
      </td>
    </tr>
  );
}

export function UnifiedDiffContent({
  parsed,
  lineHtml,
}: {
  parsed: ParsedDiff;
  lineHtml: Record<string, string>;
}) {
  return (
    <table className="diff-table">
      <tbody>
        {parsed.lines.map((line) => (
          <DiffRow key={line.key} line={line} html={lineHtml[line.key]} />
        ))}
      </tbody>
    </table>
  );
}
