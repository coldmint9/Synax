import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerContextPicker } from "../ComposerContextPicker";
import { agentRuntimeApi } from "../../../../lib/api/agentRuntime";

const props = {
  projectId: "p",
  sessionId: "s",
  backendId: "native",
  references: [],
  onChange: vi.fn(),
  disabled: false,
  onOpen: vi.fn(),
};
afterEach(() => vi.restoreAllMocks());
async function open() {
  await userEvent.click(screen.getByRole("button", { name: "添加上下文" }));
  return screen.getByRole("button", { name: /强制压缩上下文/ });
}
describe("context menu manual compaction", () => {
  it("compacts once and reports completion without replacing attached context", async () => {
    let finish!: (result: {
      compacted: boolean;
      originalTokens: number;
      tokens: number;
      reason: string;
    }) => void;
    const compact = vi
      .spyOn(agentRuntimeApi, "compactContext")
      .mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
    render(<ComposerContextPicker {...props} />);
    await userEvent.click(await open());
    expect(
      screen.getByRole("button", { name: /正在压缩上下文/ }),
    ).toBeDisabled();
    expect(compact).toHaveBeenCalledExactlyOnceWith("s");
    await act(async () =>
      finish({
        compacted: true,
        originalTokens: 2000,
        tokens: 1000,
        reason: "manual-compaction",
      }),
    );
    expect(screen.getByRole("status")).toHaveTextContent("上下文已压缩");
    expect(props.onChange).not.toHaveBeenCalled();
  });
  it.each([
    { sessionId: undefined },
    { backendId: "codex" },
    { compactDisabled: true },
  ])("disables unavailable compaction: %s", async (override) => {
    render(<ComposerContextPicker {...props} {...override} />);
    expect(await open()).toBeDisabled();
  });
  it("reports no-op and API failures rather than claiming success", async () => {
    const compact = vi
      .spyOn(agentRuntimeApi, "compactContext")
      .mockResolvedValueOnce({
        compacted: false,
        originalTokens: 10,
        tokens: 10,
        reason: "no-compressible-history",
      })
      .mockRejectedValueOnce(new Error("Session busy"));
    render(<ComposerContextPicker {...props} />);
    await userEvent.click(await open());
    expect(await screen.findByRole("status")).toHaveTextContent(
      "暂无可安全压缩",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /强制压缩上下文/ }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Session busy");
    expect(compact).toHaveBeenCalledTimes(2);
  });
});
