export type PatchDiagnosticCode =
  | "PATCH_INVALID_FORMAT"
  | "PATCH_CONTEXT_MISMATCH"
  | "PATCH_ANCHOR_NOT_FOUND"
  | "PATCH_HUNK_ORDER_CONFLICT"
  | "PATCH_AMBIGUOUS_MATCH";

export interface PatchExcerpt {
  lines: string[];
  truncated: boolean;
}

export interface PatchDiagnostic {
  error: true;
  code: PatchDiagnosticCode;
  message: string;
  applied: false;
  recovery: string;
  path?: string;
  hunkIndex?: number;
  patchLine?: number;
  searchStartLine?: number;
  /** Compared with a cached complete read/write snapshot, never a write gate. */
  readBaseline?: "changed" | "unchanged" | "unknown";
  anchor?: string;
  expectedExcerpt?: PatchExcerpt;
  actualExcerpt?: {
    startLine: number;
    lines: string[];
    truncated: boolean;
  };
  candidateLines?: number[];
  suggestedRead?: {
    path: string;
    startLine: number;
    lineCount: number;
  };
}

const MAX_MESSAGE = 420;
const MAX_LINE = 240;
const MAX_LINES = 12;
const MAX_CANDIDATES = 8;

function boundedLine(value: string): string {
  return value.length <= MAX_LINE
    ? value
    : `${value.slice(0, MAX_LINE - 19)} … [line truncated]`;
}

export function boundedExcerpt(lines: readonly string[], maxLines = MAX_LINES): PatchExcerpt {
  const shown = lines.slice(0, maxLines).map(boundedLine);
  return {
    lines: shown,
    truncated: lines.length > shown.length || lines.slice(0, maxLines).some(line => line.length > MAX_LINE),
  };
}

export function boundedActualExcerpt(
  lines: readonly string[],
  startLine: number,
  maxLines = MAX_LINES,
): PatchDiagnostic["actualExcerpt"] {
  const excerpt = boundedExcerpt(lines, maxLines);
  return {
    startLine: Math.max(1, Math.floor(startLine)),
    ...excerpt,
  };
}

export function boundedCandidates(lines: readonly number[]): number[] {
  return [...new Set(lines.filter((line) => Number.isSafeInteger(line) && line > 0))]
    .slice(0, MAX_CANDIDATES);
}

export function patchDiagnosticMessage(message: string): string {
  const clean = message.replace(/[\u0000-\u001f\u007f]/g, " ").trim();
  return clean.length <= MAX_MESSAGE
    ? clean
    : `${clean.slice(0, MAX_MESSAGE - 18).trimEnd()} … [diagnostic truncated]`;
}

export class PatchApplyError extends Error {
  readonly diagnostic: PatchDiagnostic;

  constructor(diagnostic: PatchDiagnostic) {
    const bounded: PatchDiagnostic = {
      ...diagnostic,
      message: patchDiagnosticMessage(diagnostic.message),
      recovery: patchDiagnosticMessage(diagnostic.recovery),
      ...(diagnostic.anchor === undefined
        ? {}
        : { anchor: boundedLine(diagnostic.anchor) }),
    };
    super(JSON.stringify(bounded));
    this.name = "PatchApplyError";
    this.diagnostic = bounded;
  }
}

export function invalidPatchDiagnostic(
  message: string,
  recovery = "Read the current file and rebuild the patch with the exact Begin/End envelope; do not retry the same patch unchanged.",
): PatchDiagnostic {
  return {
    error: true,
    code: "PATCH_INVALID_FORMAT",
    message: patchDiagnosticMessage(message),
    applied: false,
    recovery,
  };
}
