import { diffArrays } from "diff";

/** Merge editing is driven by Git's conflict markers, never a guessed merge-base.
 * Offsets refer to result bytes in JS string units and IDs survive edits/undo. */
export type MergeDecision =
  | "target"
  | "source"
  | "target-source"
  | "source-target"
  | "base"
  | "delete"
  | "confirm"
  | "reset";
export interface MergeRow {
  id: string;
  block: number;
  target: string;
  source: string;
  base: string;
  targetLine?: number;
  sourceLine?: number;
  baseLine?: number;
  start: number;
  end: number;
  reviewed: boolean;
  mapped: boolean;
  baseKnown: boolean;
}
export interface MergeModel {
  text: string;
  rows: MergeRow[];
  version: number;
  markerError?: string;
}
export const linesOf = (text: string): string[] =>
  text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
export function hasConflictMarkers(text: string): boolean {
  return /^(?:<{7,}|\|{7,}|={7,}|>{7,})(?:\s.*)?\r?$/m.test(text);
}

// Pair replacement lines and represent extra insertions/deletions as empty-side
// ranges. No content lookup is used when applying a decision (duplicates safe).
function createRows(
  target: string,
  source: string,
  base: string,
  block: number,
  start: number,
  targetLine: number,
  sourceLine: number,
  baseLine: number,
  baseKnown = true,
): MergeRow[] {
  const t = linesOf(target),
    s = linesOf(source),
    b = linesOf(base);
  const count = Math.max(t.length, s.length, b.length, 1);
  let offset = start;
  return Array.from({ length: count }, (_, i) => {
    const text = t[i] ?? "";
    const row: MergeRow = {
      id: `${block}:${i}`,
      block,
      target: text,
      source: s[i] ?? "",
      base: b[i] ?? "",
      targetLine: i < t.length ? targetLine + i : undefined,
      sourceLine: i < s.length ? sourceLine + i : undefined,
      baseLine: i < b.length ? baseLine + i : undefined,
      start: offset,
      end: offset + text.length,
      reviewed: false,
      mapped: true,
      baseKnown,
    };
    offset = row.end;
    return row;
  });
}

export function createMergeModel(file: {
  result: string;
  target: string;
  source: string;
  base: string;
  conflicted: boolean;
}): MergeModel {
  const lines = linesOf(file.result);
  let text = "",
    cursor = 0,
    block = 0,
    targetLine = 1,
    sourceLine = 1,
    baseLine = 1;
  const rows: MergeRow[] = [];
  let targetView = "",
    sourceView = "",
    baseView = "";
  while (cursor < lines.length) {
    const line = lines[cursor];
    const marker = /^(<{7,})(?:\s.*)?\r?\n?$/.exec(line);
    if (!marker) {
      targetView += line;
      sourceView += line;
      baseView += line;
      text += line;
      cursor++;
      targetLine++;
      sourceLine++;
      baseLine++;
      continue;
    }
    const width = marker[1].length;
    const isMarker = (value: string, char: string) =>
      new RegExp(`^${char.repeat(width)}(?:\\s.*)?\\r?\\n?$`).test(value);
    const start = cursor++;
    const t: string[] = [],
      s: string[] = [],
      b: string[] = [];
    let baseKnown = false;
    while (
      cursor < lines.length &&
      !isMarker(lines[cursor], "\\|") &&
      !isMarker(lines[cursor], "=")
    )
      t.push(lines[cursor++]);
    if (cursor < lines.length && isMarker(lines[cursor], "\\|")) {
      baseKnown = true;
      cursor++;
      while (cursor < lines.length && !isMarker(lines[cursor], "="))
        b.push(lines[cursor++]);
    }
    if (cursor === lines.length)
      return {
        text: file.result,
        rows: [],
        version: 0,
        markerError: `冲突标记不完整（第 ${start + 1} 行），请修复后重新打开文件。`,
      };
    cursor++;
    while (cursor < lines.length && !isMarker(lines[cursor], ">"))
      s.push(lines[cursor++]);
    if (cursor === lines.length)
      return {
        text: file.result,
        rows: [],
        version: 0,
        markerError: `冲突结束标记缺失（第 ${start + 1} 行）。`,
      };
    cursor++;
    rows.push(
      ...createRows(
        t.join(""),
        s.join(""),
        b.join(""),
        ++block,
        text.length,
        targetLine,
        sourceLine,
        baseLine,
        baseKnown,
      ),
    );
    targetView += t.join("");
    sourceView += s.join("");
    baseView += b.join("");
    text += t.join("");
    targetLine += t.length;
    sourceLine += s.length;
    baseLine += b.length;
  }
  if (!rows.length && file.conflicted) {
    // A draft may have removed all markers while the Git index stays unmerged.
    // Without persisted mapping metadata it requires explicit manual review.
    const fallback = createRows(
      file.target,
      file.source,
      file.base,
      1,
      0,
      1,
      1,
      1,
    );
    return {
      text: file.result,
      rows: fallback.map((row) => ({
        ...row,
        mapped: false,
        start: 0,
        end: 0,
      })),
      version: 0,
    };
  }
  if (!rows.length) return { text, rows, version: 0 };
  // Git's output includes auto-merged changes absent from the original side.
  // Map reconstructed side positions back to stage contents for honest gutters.
  const originalLines = (original: string, view: string) => {
    let originalLine = 1,
      viewLine = 1;
    const mapping = new Map<number, number>();
    const key = (line: string) => line.replace(/\r?\n$/, "");
    for (const part of diffArrays(
      linesOf(original).map(key),
      linesOf(view).map(key),
    )) {
      if (part.removed) originalLine += part.value.length;
      else if (part.added) viewLine += part.value.length;
      else
        for (let i = 0; i < part.value.length; i++)
          mapping.set(viewLine++, originalLine++);
    }
    return mapping;
  };
  const targetMap = originalLines(file.target, targetView),
    sourceMap = originalLines(file.source, sourceView),
    baseMap = originalLines(file.base, baseView);
  const targetTokens = linesOf(file.target),
    sourceTokens = linesOf(file.source),
    baseTokens = linesOf(file.base);
  const stageText = (
    line: number | undefined,
    map: Map<number, number>,
    tokens: string[],
    fallback: string,
  ) => {
    const original = line === undefined ? undefined : map.get(line);
    return original === undefined ? fallback : tokens[original - 1];
  };
  return {
    text,
    rows: rows.map((row) => ({
      ...row,
      target: stageText(row.targetLine, targetMap, targetTokens, row.target),
      source: stageText(row.sourceLine, sourceMap, sourceTokens, row.source),
      base: stageText(row.baseLine, baseMap, baseTokens, row.base),
      targetLine:
        row.targetLine === undefined
          ? undefined
          : targetMap.get(row.targetLine),
      sourceLine:
        row.sourceLine === undefined
          ? undefined
          : sourceMap.get(row.sourceLine),
      baseLine:
        row.baseLine === undefined ? undefined : baseMap.get(row.baseLine),
    })),
    version: 0,
  };
}

function chosenText(row: MergeRow, decision: MergeDecision): string {
  if (decision === "delete") return "";
  if (decision === "target-source")
    return row.target === row.source
      ? row.target
      : joinSides(row.target, row.source);
  if (decision === "source-target")
    return row.target === row.source
      ? row.target
      : joinSides(row.source, row.target);
  return decision === "source"
    ? row.source
    : decision === "base"
      ? row.base
      : row.target;
}
function joinSides(first: string, second: string): string {
  if (!first || !second) return first + second;
  return first + (first.endsWith("\n") ? "" : "\n") + second;
}

export function decideRows(
  model: MergeModel,
  ids: string[],
  decision: MergeDecision,
  expectedVersion = model.version,
): MergeModel {
  if (expectedVersion !== model.version)
    throw new Error("行映射已变化，请使用当前版本重新操作。");
  const selected = new Set(ids);
  if (
    decision === "base" &&
    model.rows.some((row) => selected.has(row.id) && !row.baseKnown)
  )
    throw new Error("该冲突没有 Base 范围信息，请查看完整 Base 后手动编辑。");
  if (ids.some((id) => !model.rows.some((row) => row.id === id)))
    throw new Error("选中行已失效。");
  if (decision === "confirm")
    return {
      ...model,
      version: model.version + 1,
      rows: model.rows.map((row) =>
        selected.has(row.id) ? { ...row, reviewed: true } : row,
      ),
    };
  if (model.rows.some((row) => selected.has(row.id) && !row.mapped))
    throw new Error(
      "手动编辑已改变这些行的范围，请确认当前结果或撤销编辑后再采用来源行。",
    );
  let text = model.text;
  let rows = model.rows.map((row) => ({ ...row }));
  // Original row order disambiguates multiple insertions at the same offset.
  for (let index = 0; index < rows.length; index++) {
    const row = rows[index];
    if (!selected.has(row.id)) continue;
    const value = chosenText(row, decision);
    const delta = value.length - (row.end - row.start);
    text = text.slice(0, row.start) + value + text.slice(row.end);
    const oldEnd = row.end;
    rows = rows.map((other, j) =>
      j === index
        ? {
            ...other,
            end: other.start + value.length,
            reviewed: !["target-source", "source-target", "reset"].includes(
              decision,
            ),
          }
        : j > index && other.start >= oldEnd
          ? { ...other, start: other.start + delta, end: other.end + delta }
          : other,
    );
  }
  return { ...model, text, rows, version: model.version + 1 };
}

export function editMergeResult(model: MergeModel, text: string): MergeModel {
  if (text === model.text) return model;
  let start = 0,
    oldEnd = model.text.length,
    newEnd = text.length;
  while (start < oldEnd && start < newEnd && model.text[start] === text[start])
    start++;
  while (
    oldEnd > start &&
    newEnd > start &&
    model.text[oldEnd - 1] === text[newEnd - 1]
  ) {
    oldEnd--;
    newEnd--;
  }
  const delta = text.length - model.text.length;
  const affected = model.rows.filter(
    (row) =>
      row.mapped &&
      (start === oldEnd
        ? row.start <= start && row.end >= start
        : (row.start < oldEnd && row.end > start) ||
          (row.start === row.end && row.start >= start && row.start <= oldEnd)),
  );
  const exact =
    affected.length === 1 &&
    start >= affected[0].start &&
    oldEnd <= affected[0].end;
  const ids = new Set(affected.map((row) => row.id));
  return {
    ...model,
    text,
    version: model.version + 1,
    rows: model.rows.map((row) => {
      if (!row.mapped) return { ...row, reviewed: false };
      if (ids.has(row.id))
        return {
          ...row,
          reviewed: false,
          mapped: exact,
          end: exact ? row.end + delta : row.start,
        };
      if (row.start >= oldEnd)
        return { ...row, start: row.start + delta, end: row.end + delta };
      return row;
    }),
  };
}
export function canResolve(model: MergeModel): boolean {
  return (
    !model.markerError &&
    !hasConflictMarkers(model.text) &&
    model.rows.every((row) => row.reviewed)
  );
}

export function editMergeRow(
  model: MergeModel,
  id: string,
  value: string,
): MergeModel {
  const index = model.rows.findIndex((row) => row.id === id);
  const row = model.rows[index];
  if (!row?.mapped) throw new Error("行范围已失效，请在完整结果中编辑。");
  const delta = value.length - (row.end - row.start);
  return {
    ...model,
    version: model.version + 1,
    text: model.text.slice(0, row.start) + value + model.text.slice(row.end),
    rows: model.rows.map((other, i) =>
      i === index
        ? { ...other, end: other.start + value.length, reviewed: false }
        : i > index
          ? { ...other, start: other.start + delta, end: other.end + delta }
          : other,
    ),
  };
}

/** Restore only this row's last decision, leaving every other row intact. */
export function undoMergeRow(
  model: MergeModel,
  id: string,
  history: MergeModel[],
): MergeModel {
  const row = model.rows.find((item) => item.id === id);
  if (!row?.mapped) throw new Error("行范围已变化，请使用全局撤销。");
  for (let i = history.length - 1; i >= 0; i--) {
    const before = history[i],
      previous = before.rows.find((item) => item.id === id);
    if (!previous?.mapped) continue;
    const value = before.text.slice(previous.start, previous.end);
    if (
      value === model.text.slice(row.start, row.end) &&
      row.reviewed === previous.reviewed
    )
      continue;
    const restored = editMergeRow(model, id, value);
    return {
      ...restored,
      rows: restored.rows.map((item) =>
        item.id === id ? { ...item, reviewed: previous.reviewed } : item,
      ),
    };
  }
  return model;
}

export const MAX_RESOLUTION_STATE_BYTES = 100 * 1024;
export interface MergeResolutionInput {
  id?: string;
  path?: string;
  base: string;
  target: string;
  source: string;
  result: string;
  conflicted: boolean;
  baseExists?: boolean;
  targetExists?: boolean;
  sourceExists?: boolean;
  resolutionState?: unknown;
}
/** Stored beside a draft by the adapter. The server binds this payload to its
 * resulting revision; signatures independently prevent applying it to other
 * stage inputs or edited result text. It is UI state, not resolve authority. */
export interface MergeResolutionState {
  schemaVersion: 1;
  inputSignature: string;
  resultSignature: string;
  modelVersion: number;
  rows: MergeRow[];
}

async function signature(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const hash = await globalThis.crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(hash), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}
function inputText(file: MergeResolutionInput): string {
  return JSON.stringify([
    file.id ?? null,
    file.path ?? null,
    file.base,
    file.target,
    file.source,
    file.baseExists ?? null,
    file.targetExists ?? null,
    file.sourceExists ?? null,
  ]);
}
function withinStateBudget(state: unknown): boolean {
  try {
    return (
      new TextEncoder().encode(JSON.stringify(state)).byteLength <=
      MAX_RESOLUTION_STATE_BYTES
    );
  } catch {
    return false;
  }
}

export async function serializeMergeResolutionState(
  model: MergeModel,
  file: MergeResolutionInput,
): Promise<MergeResolutionState | undefined> {
  if (model.markerError || !globalThis.crypto?.subtle) return undefined;
  const [inputSignature, resultSignature] = await Promise.all([
    signature(inputText(file)),
    signature(model.text),
  ]);
  const state: MergeResolutionState = {
    schemaVersion: 1,
    inputSignature,
    resultSignature,
    modelVersion: model.version,
    rows: model.rows.map((row) =>
      row.mapped ? { ...row } : { ...row, start: 0, end: 0 },
    ),
  };
  return withinStateBudget(state) ? state : undefined;
}

/** Rejects malformed, oversized, wrong-input and stale-result metadata. Never
 * infers confirmation from marker absence, and never trusts overlapping ranges. */
export async function hydrateMergeResolutionState(
  file: MergeResolutionInput,
): Promise<MergeModel | null> {
  const state = file.resolutionState;
  if (!state || typeof state !== "object" || !withinStateBudget(state))
    return null;
  const candidate = state as Partial<MergeResolutionState>;
  if (
    candidate.schemaVersion !== 1 ||
    !Number.isSafeInteger(candidate.modelVersion) ||
    candidate.modelVersion! < 0 ||
    !Array.isArray(candidate.rows) ||
    candidate.rows.length > 5000 ||
    typeof candidate.inputSignature !== "string" ||
    typeof candidate.resultSignature !== "string" ||
    !/^[a-f0-9]{64}$/.test(candidate.inputSignature) ||
    !/^[a-f0-9]{64}$/.test(candidate.resultSignature)
  )
    return null;
  if (file.conflicted && candidate.rows.length === 0) return null;
  const ids = new Set<string>();
  const target = linesOf(file.target),
    source = linesOf(file.source),
    base = linesOf(file.base);
  let previousEnd = 0,
    previousBlock = 0;
  const rows: MergeRow[] = [];
  for (const value of candidate.rows) {
    if (!value || typeof value !== "object") return null;
    const row = value as Partial<MergeRow>;
    if (
      typeof row.id !== "string" ||
      !/^\d+:\d+$/.test(row.id) ||
      ids.has(row.id) ||
      !Number.isSafeInteger(row.block) ||
      row.block! < 1 ||
      row.block! < previousBlock ||
      !row.id.startsWith(`${row.block}:`) ||
      typeof row.target !== "string" ||
      typeof row.source !== "string" ||
      typeof row.base !== "string" ||
      typeof row.reviewed !== "boolean" ||
      typeof row.mapped !== "boolean" ||
      typeof row.baseKnown !== "boolean" ||
      !Number.isSafeInteger(row.start) ||
      !Number.isSafeInteger(row.end) ||
      row.start! < 0 ||
      row.end! < row.start! ||
      row.end! > file.result.length ||
      (row.mapped && row.start! < previousEnd)
    )
      return null;
    for (const [line, text, tokens] of [
      [row.targetLine, row.target, target],
      [row.sourceLine, row.source, source],
      [row.baseLine, row.base, base],
    ] as const) {
      if (
        line !== undefined &&
        (!Number.isSafeInteger(line) ||
          line < 1 ||
          line > tokens.length ||
          text !== tokens[line - 1])
      )
        return null;
    }
    ids.add(row.id);
    previousBlock = row.block!;
    if (row.mapped) previousEnd = row.end!;
    // Copy only known properties, so unknown input never enters live UI state.
    rows.push({
      id: row.id,
      block: row.block!,
      target: row.target,
      source: row.source,
      base: row.base,
      targetLine: row.targetLine,
      sourceLine: row.sourceLine,
      baseLine: row.baseLine,
      start: row.start!,
      end: row.end!,
      reviewed: row.reviewed,
      mapped: row.mapped,
      baseKnown: row.baseKnown,
    });
  }
  const [inputSignature, resultSignature] = await Promise.all([
    signature(inputText(file)),
    signature(file.result),
  ]);
  if (
    candidate.inputSignature !== inputSignature ||
    candidate.resultSignature !== resultSignature
  )
    return null;
  return { text: file.result, rows, version: candidate.modelVersion! };
}
