import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerContextPicker } from "../ComposerContextPicker";
import { agentRuntimeApi } from "../../../../lib/api/agentRuntime";
import { useAgentSessionStore } from "../state/agentSessionStore";

const props = {
  projectId: "p",
  sessionId: "s",
  backendId: "native",
  references: [],
  onChange: vi.fn(),
  disabled: false,
  onOpen: vi.fn(),
};
afterEach(() => {
  vi.restoreAllMocks();
  useAgentSessionStore.setState({ contextCompactionNotice: null });
});
async function open() {
  await userEvent.click(screen.getByRole("button", { name: "添加上下文" }));
  return screen.getByRole("button", { name: /强制压缩上下文/ });
}
describe("context menu manual compaction", () => {
  it("compacts once and reports completion without replacing attached context", async () => {
    let finish!: (result: { accepted: true; status: "compacting" }) => void;
    const compact = vi
      .spyOn(agentRuntimeApi, "compactContext")
      .mockImplementation(
        () => new Promise((resolve) => { finish = resolve; }),
      );
    render(<ComposerContextPicker {...props} />);
    await userEvent.click(await open());
    expect(
      screen.getByRole("button", { name: /正在压缩上下文/ }),
    ).toBeDisabled();
    expect(compact).toHaveBeenCalledExactlyOnceWith("s");
    expect(useAgentSessionStore.getState().contextCompactionNotice).toEqual({
      status: "running",
    });
    await act(async () => finish({ accepted: true, status: "compacting" }));
    expect(screen.getByRole("status")).toHaveTextContent("上下文压缩已开始");
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
      .mockResolvedValueOnce({ accepted: true, status: "compacting" })
      .mockRejectedValueOnce(new Error("Session busy"));
    render(<ComposerContextPicker {...props} />);
    await userEvent.click(await open());
    expect(await screen.findByRole("status")).toHaveTextContent(
      "上下文压缩已开始",
    );
    await userEvent.click(
      screen.getByRole("button", { name: /强制压缩上下文/ }),
    );
    expect(await screen.findByRole("alert")).toHaveTextContent("Session busy");
    expect(compact).toHaveBeenCalledTimes(2);
  });
});
