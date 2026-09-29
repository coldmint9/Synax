import { useState, type ComponentProps } from "react";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { WorkspaceProjectSources } from "./WorkspaceProjectSources";

vi.mock("../../../hooks/useLocale", () => ({
  useLocale: () => ({ locale: "zh" }),
}));

type Props = ComponentProps<typeof WorkspaceProjectSources>;
function setup(overrides: Partial<Props> = {}) {
  const callbacks = {
    onBrowse: vi.fn(),
    onAddPath: vi.fn(),
    onChoose: vi.fn(),
    onRetry: vi.fn(),
  };
  function Harness() {
    const [compact, setCompact] = useState(true);
    const [path, setPath] = useState("");
    const [mode, setMode] = useState<"local" | "existing">("local");
    return (
      <WorkspaceProjectSources
        projects={[]}
        loading={false}
        paths={[]}
        simplified
        compact={compact}
        onCompactChange={setCompact}
        path={path}
        onPathChange={setPath}
        mode={mode}
        onModeChange={setMode}
        {...callbacks}
        {...overrides}
      />
    );
  }
  return { ...render(<Harness />), ...callbacks, user: userEvent.setup() };
}

describe("WorkspaceProjectSources directory entry", () => {
  it("puts a single folder action before secondary actions, without the old nested card", async () => {
    const { container, user, onBrowse } = setup();
    const buttons = screen.getAllByRole("button");
    expect(buttons.map((button) => button.textContent)).toEqual([
      "选择文件夹",
      "手动输入路径",
      "已有项目",
    ]);
    expect(container.querySelector(".workspace-browse")).toBeNull();
    expect(screen.queryByText("本地目录")).not.toBeInTheDocument();
    expect(screen.queryByText("可一次选择多个目录")).not.toBeInTheDocument();
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(within(buttons[0]).queryByRole("button")).not.toBeInTheDocument();
    await user.tab();
    expect(buttons[0]).toHaveFocus();
    await user.keyboard("{Enter}");
    expect(onBrowse).toHaveBeenCalledTimes(1);
  });

  it("expands and collapses manual entry without losing focus or the typed path", async () => {
    const { user, onAddPath } = setup();
    const toggle = screen.getByRole("button", { name: "手动输入路径" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    await user.click(toggle);
    expect(toggle).toHaveFocus();
    expect(toggle).toHaveAttribute("aria-expanded", "true");
    const input = screen.getByRole("textbox", { name: "项目目录路径" });
    expect(
      document.getElementById(toggle.getAttribute("aria-controls")!),
    ).toContainElement(input);
    await user.type(input, "/repos/my-app");
    await user.click(toggle);
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    expect(toggle).toHaveFocus();
    await user.click(toggle);
    expect(screen.getByRole("textbox")).toHaveValue("/repos/my-app");
    await user.click(screen.getByRole("button", { name: "添加", exact: true }));
    expect(onAddPath).toHaveBeenCalledTimes(1);
  });

  it("keeps the existing-project route and return to folder selection", async () => {
    const { user } = setup();
    await user.click(screen.getByRole("button", { name: "已有项目" }));
    expect(
      screen.getByRole("textbox", { name: "搜索名称或路径" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "选择文件夹" }),
    ).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "本地" }));
    expect(
      screen.getByRole("button", { name: "选择文件夹" }),
    ).toBeInTheDocument();
  });

  it("disables the primary and secondary actions during submission", async () => {
    const { user, onBrowse } = setup({ disabled: true });
    for (const button of screen.getAllByRole("button"))
      expect(button).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "选择文件夹" }));
    expect(onBrowse).not.toHaveBeenCalled();
  });

  it("retains a visible path field in the shared project-management variant", () => {
    setup({ simplified: false, compact: false });
    expect(
      screen.getByRole("button", { name: "选择文件夹" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("textbox", { name: "项目目录路径" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "手动输入路径" }),
    ).not.toBeInTheDocument();
  });
});
