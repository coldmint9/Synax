import { describe, expect, it } from "vitest";
import {
  canResolve,
  createMergeModel,
  decideRows,
  editMergeResult,
  editMergeRow,
  undoMergeRow,
  serializeMergeResolutionState,
  hydrateMergeResolutionState,
  MAX_RESOLUTION_STATE_BYTES,
} from "./mergeModel";

const fixture = (
  target = "A\nB\n",
  source = "a\nb\n",
  base = "old\nold2\n",
) => ({
  base: `before\n${base}after\n`,
  target: `before\n${target}after\n`,
  source: `before\n${source}after\n`,
  conflicted: true,
  result: `before\n<<<<<<< HEAD\n${target}||||||| base\n${base}=======\n${source}>>>>>>> source\nafter\n`,
});

describe("shared merge row model", () => {
  it("uses actual diff3 regions, preserving auto-merged text and independent mixed decisions", () => {
    let model = createMergeModel(fixture());
    expect(model.text).toBe("before\nA\nB\nafter\n");
    expect(model.rows).toHaveLength(2);
    model = decideRows(model, ["1:0"], "source");
    expect(model.text).toBe("before\na\nB\nafter\n");
    expect(model.rows.map((row) => row.reviewed)).toEqual([true, false]);
    expect(canResolve(model)).toBe(false);
    model = decideRows(model, ["1:1"], "target");
    expect(canResolve(model)).toBe(true);
  });
  it("applies empty-side insertions at stable offsets without changing adjacent duplicate lines", () => {
    let model = createMergeModel(
      fixture("same\n", "same\nnew\nlast\n", "same\n"),
    );
    model = decideRows(model, ["1:2"], "source");
    model = decideRows(model, ["1:1"], "source");
    expect(model.text).toBe("before\nsame\nnew\nlast\nafter\n");
    expect(
      model.rows.map((row) => model.text.slice(row.start, row.end)),
    ).toEqual(["same\n", "new\n", "last\n"]);
  });
  it("represents deletion explicitly and never treats an empty result as confirmation", () => {
    let model = createMergeModel(fixture("A\nB\n", "", "A\nB\n"));
    model = editMergeRow(model, "1:0", "");
    expect(canResolve(model)).toBe(false);
    model = decideRows(model, ["1:0", "1:1"], "delete");
    expect(model.text).toBe("before\nafter\n");
    expect(canResolve(model)).toBe(true);
  });
  it("supports both orders with explicit review and deduplicates identical sides", () => {
    let model = createMergeModel(fixture());
    model = decideRows(model, ["1:0"], "source-target");
    expect(model.text).toBe("before\na\nA\nB\nafter\n");
    expect(model.rows[0].reviewed).toBe(false);
    model = decideRows(model, ["1:1"], "target-source");
    expect(model.text).toBe("before\na\nA\nB\nb\nafter\n");
    model = decideRows(model, ["1:0", "1:1"], "confirm");
    expect(canResolve(model)).toBe(true);
    const same = decideRows(
      createMergeModel(fixture("same\n", "same\n", "same\n")),
      ["1:0"],
      "target-source",
    );
    expect(same.text).toBe("before\nsame\nafter\n");
  });
  it("preserves unrelated decisions after editing and rejects stale row operations", () => {
    let model = decideRows(
      createMergeModel(fixture()),
      ["1:0", "1:1"],
      "target",
    );
    const oldVersion = model.version;
    model = editMergeResult(model, "before\nmanual\nB\nafter\n");
    expect(model.rows.map((row) => row.reviewed)).toEqual([false, true]);
    expect(() => decideRows(model, ["1:1"], "source", oldVersion)).toThrow(
      "映射已变化",
    );
    model = decideRows(model, ["1:1"], "source");
    expect(model.text).toBe("before\nmanual\nb\nafter\n");
  });
  it("invalidates ambiguous mappings after a multi-row paste and requires review", () => {
    let model = decideRows(
      createMergeModel(fixture()),
      ["1:0", "1:1"],
      "target",
    );
    model = editMergeResult(model, "before\nentirely new\nmore\nafter\n");
    expect(model.rows.every((row) => !row.mapped && !row.reviewed)).toBe(true);
    expect(() => decideRows(model, ["1:0"], "target")).toThrow("范围");
    expect(canResolve(model)).toBe(false);
    model = decideRows(model, ["1:0", "1:1"], "confirm");
    expect(canResolve(model)).toBe(true);
  });
  it("keeps an unmerged marker-free draft pending and blocks malformed markers", () => {
    const draft = createMergeModel({ ...fixture(), result: "manual draft\n" });
    expect(draft.text).toBe("manual draft\n");
    expect(canResolve(draft)).toBe(false);
    expect(draft.rows.every((row) => !row.reviewed && !row.mapped)).toBe(true);
    expect(
      canResolve(
        createMergeModel({ ...fixture(), result: "<<<<<<< HEAD\nA\n" }),
      ),
    ).toBe(false);
  });
  it("undoes only one row while retaining a later decision on another row", () => {
    const initial = createMergeModel(fixture());
    const first = decideRows(initial, ["1:0"], "source");
    const second = decideRows(first, ["1:1"], "source");
    const restored = undoMergeRow(second, "1:0", [initial, first]);
    expect(restored.text).toBe("before\nA\nb\nafter\n");
    expect(restored.rows.map((row) => row.reviewed)).toEqual([false, true]);
  });
  it("maps gutters to real stage lines despite source-only nonconflict insertions", () => {
    const input = fixture();
    const model = createMergeModel({
      ...input,
      result: "source-only\n" + input.result,
      source: "source-only\n" + input.source,
    });
    expect(model.rows[0].targetLine).toBe(2);
    expect(model.rows[0].sourceLine).toBe(3);
  });
  it("does not claim a Base mapping when Git returned two-way markers", () => {
    const input = fixture();
    const model = createMergeModel({
      ...input,
      result: "<<<<<<< HEAD\nA\n=======\na\n>>>>>>> branch\n",
    });
    expect(model.rows[0].baseKnown).toBe(false);
    expect(() => decideRows(model, ["1:0"], "base")).toThrow("Base 范围");
  });
  it("preserves CRLF and no-final-newline plain files", () => {
    const model = createMergeModel({
      base: "",
      target: "",
      source: "",
      conflicted: false,
      result: "a\r\nb",
    });
    expect(model.text).toBe("a\r\nb");
  });
  it("restores a side's missing final newline despite Git adding marker separators", () => {
    const model = createMergeModel({
      base: "base",
      target: "target",
      source: "source",
      conflicted: true,
      result:
        "<<<<<<< HEAD\ntarget\n||||||| ancestor\nbase\n=======\nsource\n>>>>>>> source\n",
    });
    expect(decideRows(model, ["1:0"], "source").text).toBe("source");
    expect(decideRows(model, ["1:0"], "base").text).toBe("base");
  });
  it("retains exact row identity when a row gains several lines", () => {
    let model = createMergeModel(fixture());
    model = editMergeRow(model, "1:0", "one\ntwo\nthree\n");
    model = decideRows(model, ["1:1"], "source");
    expect(model.text).toBe("before\none\ntwo\nthree\nb\nafter\n");
    expect(model.rows.map((row) => row.id)).toEqual(["1:0", "1:1"]);
  });
});

describe("versioned merge resolution persistence", () => {
  it("round-trips confirmed and manual rows bound to the exact inputs and result", async () => {
    const file = fixture();
    let model = decideRows(createMergeModel(file), ["1:0"], "source");
    model = editMergeRow(model, "1:1", "custom\nextra\n");
    const resolutionState = await serializeMergeResolutionState(model, file);
    expect(resolutionState?.schemaVersion).toBe(1);
    expect(
      await hydrateMergeResolutionState({
        ...file,
        result: model.text,
        resolutionState,
      }),
    ).toEqual(model);
    expect(
      await hydrateMergeResolutionState({
        ...file,
        result: model.text + "changed",
        resolutionState,
      }),
    ).toBeNull();
    expect(
      await hydrateMergeResolutionState({
        ...file,
        result: model.text,
        target: "changed stage\n",
        resolutionState,
      }),
    ).toBeNull();
  });
  it("rejects malformed, oversized and overlapping row state", async () => {
    const file = fixture(),
      model = createMergeModel(file);
    const state = (await serializeMergeResolutionState(model, file))!;
    for (const resolutionState of [
      { ...state, schemaVersion: 2 },
      { ...state, modelVersion: -1 },
      { ...state, rows: [state.rows[0], state.rows[0]] },
      { ...state, rows: [state.rows[0], { ...state.rows[1], start: 0 }] },
      { ...state, rows: [{ ...state.rows[0], end: 1e9 }] },
      { ...state, unused: "x".repeat(MAX_RESOLUTION_STATE_BYTES) },
      { ...state, rows: [{ ...state.rows[0], target: "forged stage line" }] },
    ])
      expect(
        await hydrateMergeResolutionState({
          ...file,
          result: model.text,
          resolutionState,
        }),
      ).toBeNull();
    expect(
      await serializeMergeResolutionState(
        {
          ...model,
          rows: model.rows.map((row) => ({
            ...row,
            target: "x".repeat(MAX_RESOLUTION_STATE_BYTES),
          })),
        },
        file,
      ),
    ).toBeUndefined();
  });
  it("keeps unmapped manual regions pending and preserves neighboring confirmed ranges after reopen", async () => {
    const file = fixture();
    let model = decideRows(createMergeModel(file), ["1:0"], "source");
    model = editMergeRow(model, "1:1", "many\nmanual\nlines\n");
    const state = await serializeMergeResolutionState(model, file);
    const restored = (await hydrateMergeResolutionState({
      ...file,
      result: model.text,
      resolutionState: state,
    }))!;
    const decided = decideRows(restored, ["1:0"], "target");
    expect(decided.text).toBe("before\nA\nmany\nmanual\nlines\nafter\n");
    expect(decided.rows[1].reviewed).toBe(false);
    model = editMergeResult(model, "replacement whole file\n");
    const unmapped = await serializeMergeResolutionState(model, file);
    const restoredUnmapped = await hydrateMergeResolutionState({
      ...file,
      result: model.text,
      resolutionState: unmapped,
    });
    expect(
      restoredUnmapped?.rows.every((row) => !row.mapped && !row.reviewed),
    ).toBe(true);
  });
});
