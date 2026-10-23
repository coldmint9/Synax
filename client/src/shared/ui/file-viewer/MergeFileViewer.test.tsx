import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { MergeFileViewer } from "./MergeFileViewer";
vi.mock("./MonacoMergeWorkbench", () => ({
  default: ({ file, readOnly, managed }: any) => (
    <div
      role="dialog"
      aria-label={file.path}
      data-readonly={readOnly}
      data-managed={managed}
    />
  ),
}));
afterEach(cleanup);
it("lazily delegates to the shared Monaco workbench with the task ownership mode", async () => {
  render(
    <MergeFileViewer
      file={{ id: "f", path: "sample.java" } as any}
      managed
      readOnly
      onSave={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  await waitFor(() => {
    const dialog = screen.getByRole("dialog", { name: "sample.java" });
    expect(dialog).toHaveAttribute("data-managed", "true");
    expect(dialog).toHaveAttribute("data-readonly", "true");
  });
});
