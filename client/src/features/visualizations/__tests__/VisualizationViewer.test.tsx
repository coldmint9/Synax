import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const saveHtmlFileToUserLocation = vi.fn();
vi.mock("../../../shared/lib/save-html-file", () => ({
  saveHtmlFileToUserLocation: (...args: unknown[]) =>
    saveHtmlFileToUserLocation(...args),
  htmlFileName: (title?: string) => `${title ?? "visualization"}.html`,
}));

import { VisualizationViewer } from "../VisualizationViewer";
import { useNotificationStore } from "../../../shared/state/notificationStore";

const visualization = {
  id: "message:demo",
  html: '<div id="demo">全景</div>',
  title: "智能客服全景",
};

function renderViewer(onClose = vi.fn()) {
  render(<VisualizationViewer visualization={visualization} onClose={onClose} />);
  return onClose;
}

/** The loading artwork is also a status region, so target the export one. */
function exportStatus(): string {
  return document.querySelector("[data-export-status]")?.textContent ?? "";
}

describe("VisualizationViewer export", () => {
  beforeEach(() => {
    saveHtmlFileToUserLocation.mockReset();
    useNotificationStore.getState().clearAll();
  });

  it("exports a standalone document for the chosen location", async () => {
    saveHtmlFileToUserLocation.mockResolvedValue("saved");
    renderViewer();

    fireEvent.click(screen.getByRole("button", { name: "导出为 HTML 文件" }));

    await waitFor(() => expect(saveHtmlFileToUserLocation).toHaveBeenCalledTimes(1));
    const [request] = saveHtmlFileToUserLocation.mock.calls[0] as [
      { title?: string; html: string },
    ];
    expect(request.title).toBe("智能客服全景");
    // The exported file must run offline on its own: shell, CSP and runtime.
    expect(request.html).toContain('<div id="demo">全景</div>');
    expect(request.html).toContain("Content-Security-Policy");
    expect(request.html).toContain("synax-interactive-config");
    expect(request.html).toContain("<!doctype html>");
    await waitFor(() => expect(exportStatus()).toBe("已导出为 HTML 文件"));
  });

  it("stays quiet when the save dialog is dismissed", async () => {
    saveHtmlFileToUserLocation.mockResolvedValue("canceled");
    renderViewer();

    fireEvent.click(screen.getByRole("button", { name: "导出为 HTML 文件" }));

    await waitFor(() => expect(saveHtmlFileToUserLocation).toHaveBeenCalledTimes(1));
    expect(exportStatus()).toBe("");
    expect(useNotificationStore.getState().notifications).toHaveLength(0);
  });

  it("reports a failed write instead of pretending the file exists", async () => {
    saveHtmlFileToUserLocation.mockRejectedValue(new Error("磁盘已满"));
    renderViewer();

    fireEvent.click(screen.getByRole("button", { name: "导出为 HTML 文件" }));

    await waitFor(() =>
      expect(useNotificationStore.getState().notifications[0]).toMatchObject({
        type: "error",
        message: "导出失败",
        detail: "磁盘已满",
      }),
    );
    expect(exportStatus()).toBe("");
  });

  it("cannot export a preview that failed to load", async () => {
    render(
      <VisualizationViewer
        visualization={{ id: "error", error: "请简化预览" }}
        onClose={vi.fn()}
      />,
    );
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "导出为 HTML 文件" })).toBeDisabled(),
    );
  });
});
