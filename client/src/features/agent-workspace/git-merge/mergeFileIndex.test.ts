import { describe, expect, it } from "vitest";
import { MergeFileIndex } from "./mergeFileIndex";

describe("bounded merge file index", () => {
  it("updates a single file without rebuilding the stable viewport IDs", () => {
    const index = new MergeFileIndex();
    index.replace(Array.from({length: 10000}, (_, i) => ({id: String(i), path: `${i}.ts`, conflicted: true, status: "UU"})), 1);
    const ids = index.ids;
    for (let i = 0; i < 10000; i++) index.update([{id: String(i), path: `${i}.ts`, conflicted: false, status: "M"}], i + 2);
    expect(index.ids).toBe(ids); expect(index.conflicts).toBe(0); expect(index.byId.size).toBe(10000);
    index.update([{id: "0", path: "0.ts", conflicted: true, status: "UU"}], 1);
    expect(index.conflicts).toBe(0);
  });
});
