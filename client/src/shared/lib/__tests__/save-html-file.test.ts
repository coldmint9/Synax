import { afterEach, describe, expect, it, vi } from "vitest";
import { htmlFileName, saveHtmlFileToUserLocation } from "../save-html-file";

const html = "<!doctype html><p>hi</p>";

function stubDesktop(saveTextFile: (request: unknown) => Promise<unknown>) {
  (window as Window & { electronAPI?: unknown }).electronAPI = { saveTextFile };
}
function stubPicker(picker: unknown) {
  (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker = picker;
}

afterEach(() => {
  delete (window as Window & { electronAPI?: unknown }).electronAPI;
  delete (window as unknown as { showSaveFilePicker?: unknown }).showSaveFilePicker;
});

describe("saving an exported visualization", () => {
  it("derives a readable, filesystem-safe file name", () => {
    expect(htmlFileName("智能客服 全景")).toBe("智能客服 全景.html");
    expect(htmlFileName('a/b:c*?"<>|')).toBe("a-b-c-.html");
    expect(htmlFileName(undefined)).toBe("visualization.html");
    expect(htmlFileName("  ")).toBe("visualization.html");
  });

  it("uses the desktop save sheet without exposing a path", async () => {
    const saveTextFile = vi.fn().mockResolvedValue({ canceled: false, filePath: "/Users/me/x.html" });
    stubDesktop(saveTextFile);

    await expect(saveHtmlFileToUserLocation({ title: "全景", html })).resolves.toBe("saved");
    expect(saveTextFile).toHaveBeenCalledWith({
      suggestedName: "全景.html",
      contents: html,
      filters: [{ name: "HTML", extensions: ["html", "htm"] }],
    });
  });

  it("treats a dismissed desktop dialog as a decision, not an error", async () => {
    stubDesktop(vi.fn().mockResolvedValue({ canceled: true }));
    await expect(saveHtmlFileToUserLocation({ title: "全景", html })).resolves.toBe("canceled");
  });

  it("writes through the browser file picker when the desktop shell is absent", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    const close = vi.fn().mockResolvedValue(undefined);
    const picker = vi.fn().mockResolvedValue({ createWritable: async () => ({ write, close }) });
    stubPicker(picker);

    await expect(saveHtmlFileToUserLocation({ title: "全景", html })).resolves.toBe("saved");
    expect(picker).toHaveBeenCalledWith({
      suggestedName: "全景.html",
      types: [{ description: "HTML", accept: { "text/html": [".html", ".htm"] } }],
    });
    expect(write).toHaveBeenCalledWith(html);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("stops when the picker is dismissed and falls back when it is unsupported", async () => {
    stubPicker(vi.fn().mockRejectedValue(Object.assign(new Error("closed"), { name: "AbortError" })));
    await expect(saveHtmlFileToUserLocation({ title: "全景", html })).resolves.toBe("canceled");

    // The fallback emits a real anchor click; jsdom must not navigate.
    vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const createObjectURL = vi.fn(() => "blob:export");
    vi.stubGlobal("URL", { ...URL, createObjectURL, revokeObjectURL: vi.fn() });
    stubPicker(vi.fn().mockRejectedValue(new TypeError("not supported")));
    await expect(saveHtmlFileToUserLocation({ title: "全景", html })).resolves.toBe("saved");
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});
