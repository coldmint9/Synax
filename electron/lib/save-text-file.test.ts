import { describe, expect, it, vi } from "vitest";
import {
  MAX_SAVE_BYTES,
  normalizeSaveTextRequest,
  safeFileName,
  saveTextFile,
} from "./save-text-file.js";

describe("save text file", () => {
  it("keeps the dialog name a bare, filesystem-safe file name", () => {
    expect(safeFileName("智能客服 全景.html")).toBe("智能客服 全景.html");
    expect(safeFileName("../../etc/passwd")).toBe("passwd");
    expect(safeFileName('a<b>c:d"e|f?g*h')).toBe("a-b-c-d-e-f-g-h");
    expect(safeFileName("   ")).toBe("export");
    expect(safeFileName(".hidden")).toBe("hidden");
  });

  it("rejects malformed, empty and oversized renderer payloads", () => {
    expect(normalizeSaveTextRequest(null)).toBeNull();
    expect(normalizeSaveTextRequest([])).toBeNull();
    expect(normalizeSaveTextRequest({ suggestedName: "a.html" })).toBeNull();
    expect(
      normalizeSaveTextRequest({ suggestedName: "", contents: "<p/>" }),
    ).toMatchObject({ suggestedName: "export" });
    expect(normalizeSaveTextRequest({ suggestedName: "a.html", contents: "   " })).toBeNull();
    expect(
      normalizeSaveTextRequest({
        suggestedName: "a.html",
        contents: "x".repeat(MAX_SAVE_BYTES + 1),
      }),
    ).toBeNull();
  });

  it("normalizes a valid request and defaults to HTML filters", () => {
    expect(
      normalizeSaveTextRequest({
        suggestedName: "/tmp/全景.html",
        contents: "<!doctype html>",
      }),
    ).toEqual({
      suggestedName: "全景.html",
      contents: "<!doctype html>",
      filters: [{ name: "HTML", extensions: ["html", "htm"] }],
    });
  });

  it("writes the chosen path and stops on cancel", async () => {
    const writeFile = vi.fn().mockResolvedValue(undefined);
    const request = normalizeSaveTextRequest({
      suggestedName: "全景.html",
      contents: "<p>hi</p>",
    })!;

    const canceled = await saveTextFile(request, {
      dialogs: { showSaveDialog: vi.fn().mockResolvedValue({ canceled: true }) },
      writeFile,
    });
    expect(canceled).toEqual({ canceled: true });
    expect(writeFile).not.toHaveBeenCalled();

    const showSaveDialog = vi.fn().mockResolvedValue({ canceled: false, filePath: "/Users/me/全景.html" });
    const saved = await saveTextFile(request, { dialogs: { showSaveDialog }, writeFile });
    expect(showSaveDialog).toHaveBeenCalledWith({
      title: "导出可视化",
      defaultPath: "全景.html",
      filters: [{ name: "HTML", extensions: ["html", "htm"] }],
    });
    expect(writeFile).toHaveBeenCalledWith("/Users/me/全景.html", "<p>hi</p>");
    expect(saved).toEqual({ canceled: false, filePath: "/Users/me/全景.html" });
  });

  it("attaches the save sheet to the requesting window when available", async () => {
    const request = normalizeSaveTextRequest({ suggestedName: "a.html", contents: "<p/>" })!;
    const showSaveDialog = vi.fn().mockResolvedValue({ canceled: true });
    const showSaveDialogWithParent = vi.fn().mockResolvedValue({ canceled: true });
    const parent = { id: 7 };
    await saveTextFile(request, {
      dialogs: { showSaveDialog, showSaveDialogWithParent },
      writeFile: vi.fn(),
      parent,
    });
    expect(showSaveDialogWithParent).toHaveBeenCalledWith(parent, expect.objectContaining({ defaultPath: "a.html" }));
    expect(showSaveDialog).not.toHaveBeenCalled();
  });
});
