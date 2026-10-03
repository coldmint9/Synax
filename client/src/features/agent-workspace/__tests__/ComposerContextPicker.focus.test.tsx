import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ComposerContextPicker } from "../ComposerContextPicker";
import { agentRuntimeApi } from "../../../adapters/transport/agentRuntime";
import { useShellStore } from "../../../shared/state/shellStore";

const props = {
  projectId: "project-a",
  sessionId: "session-a",
  backendId: "native",
  references: [],
  onChange: vi.fn(),
  disabled: false,
  onOpen: vi.fn(),
};
beforeEach(() => {
  useShellStore.setState((state) => ({
    preferences: { ...state.preferences },
  }));
  vi.spyOn(agentRuntimeApi, "listReferenceOptions").mockResolvedValue({
    items: [],
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  useShellStore.setState(useShellStore.getInitialState());
});

describe("context picker Back focus", () => {
  it.each(["技能", "MCP 服务", "项目文件"])(
    "returns focus to %s and supports immediate keyboard reopening",
    async (label) => {
      const user = userEvent.setup();
      render(<ComposerContextPicker {...props} />);
      await user.click(screen.getByRole("button", { name: "添加上下文" }));
      await user.click(screen.getByRole("button", { name: label }));
      expect(
        screen.getByRole("combobox", { name: "搜索上下文" }),
      ).toHaveFocus();
      await user.tab({ shift: true });
      expect(
        screen.getByRole("button", { name: "返回上下文类型" }),
      ).toHaveFocus();
      await user.keyboard("{Enter}");
      expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
      expect(screen.getByRole("button", { name: label })).toHaveFocus();
      await user.keyboard("{Enter}");
      expect(
        screen.getByRole("combobox", { name: "搜索上下文" }),
      ).toHaveFocus();
    },
  );

  it("continues tab navigation from the returned type and selects the next type without a mouse", async () => {
    const user = userEvent.setup();
    render(<ComposerContextPicker {...props} />);
    const trigger = screen.getByRole("button", { name: "添加上下文" });
    await user.click(trigger);
    await user.click(screen.getByRole("button", { name: "项目文件" }));
    await user.type(
      screen.getByRole("combobox", { name: "搜索上下文" }),
      "Draft",
    );
    await user.click(screen.getByRole("button", { name: "返回上下文类型" }));
    expect(screen.getByRole("button", { name: "项目文件" })).toHaveFocus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "MCP 服务" })).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("combobox", { name: "搜索上下文" })).toHaveFocus();
    expect(screen.getByRole("combobox", { name: "搜索上下文" })).toHaveValue(
      "",
    );
    await user.keyboard("{Escape}");
    expect(trigger).toHaveFocus();
    expect(trigger).toHaveAttribute("aria-expanded", "false");
  });
});
