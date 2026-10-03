import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ComposerContextPicker } from "../ComposerContextPicker";
import { agentRuntimeApi } from "../../../adapters/transport/agentRuntime";

const props = {
  projectId: "p",
  sessionId: "s",
  backendId: "native",
  references: [],
  onChange: vi.fn(),
  disabled: false,
  onOpen: vi.fn(),
  onAttachFiles: vi.fn(),
  mode: "chat" as const,
  modeDisabled: false,
  onModeChange: vi.fn(),
};
afterEach(() => vi.restoreAllMocks());
const open = () =>
  userEvent.click(
    screen.getByRole("button", { name: "添加附件、上下文或切换模式" }),
  );

describe("unified composer plus menu", () => {
  it("has only an icon trigger and groups attachments, context and checked modes inside", async () => {
    render(<ComposerContextPicker {...props} />);
    expect(screen.getAllByRole("button")).toHaveLength(1);
    expect(screen.getByRole("button")).toHaveTextContent("");
    expect(screen.queryByText("对话")).not.toBeInTheDocument();
    await open();
    expect(
      screen.getByRole("button", { name: /添加附件.*图片/ }),
    ).toBeEnabled();
    expect(screen.getByRole("button", { name: "项目文件" })).toBeEnabled();
    expect(screen.getByRole("radio", { name: "对话" })).toBeChecked();
    await userEvent.click(screen.getByRole("radio", { name: "计划" }));
    expect(props.onModeChange).toHaveBeenCalledWith("plan");
    await waitFor(() =>
      expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument(),
    );
  });

  it("uses the native multi-file chooser, resets it and preserves media attachments", async () => {
    const add = vi.fn();
    const { container } = render(
      <ComposerContextPicker {...props} onAttachFiles={add} />,
    );
    await open();
    const input = container.querySelector(
      'input[type="file"]',
    ) as HTMLInputElement;
    const click = vi.spyOn(input, "click").mockImplementation(() => {});
    await userEvent.click(
      screen.getByRole("button", { name: /添加附件.*图片/ }),
    );
    expect(click).toHaveBeenCalledOnce();
    expect(input.multiple).toBe(true);
    const files = [
      new File(["test"], "example.txt"),
      new File(["image"], "picture.png"),
    ];
    fireEvent.change(input, { target: { files } });
    expect(add).toHaveBeenCalledWith(files);
    expect(input.value).toBe("");
  });

  it("keeps file references functional in the combined menu", async () => {
    vi.spyOn(agentRuntimeApi, "listReferenceOptions").mockResolvedValue({
      items: [{ kind: "file", id: "README.md", label: "README.md" }],
    });
    const onChange = vi.fn();
    render(<ComposerContextPicker {...props} onChange={onChange} />);
    await open();
    await userEvent.click(screen.getByRole("button", { name: "项目文件" }));
    await userEvent.click(
      await screen.findByRole("option", { name: "README.md" }),
    );
    expect(onChange).toHaveBeenCalledWith([
      { kind: "file", id: "README.md", label: "README.md" },
    ]);
  });

  it("locks mode switching independently from attachment/context actions", async () => {
    render(<ComposerContextPicker {...props} mode="goal" modeDisabled />);
    await open();
    expect(screen.getByRole("radio", { name: "目标" })).toBeChecked();
    const change = props.onModeChange.mock.calls.length;
    for (const radio of screen.getAllByRole("radio")) {
      expect(radio).toHaveAttribute("aria-disabled", "true");
      await userEvent.click(radio);
    }
    expect(props.onModeChange).toHaveBeenCalledTimes(change);
    expect(screen.getByRole("button", { name: "项目文件" })).toBeEnabled();
  });

  it("does not expose native modes or native-only context on other backends", async () => {
    render(<ComposerContextPicker {...props} backendId="codex" />);
    await open();
    expect(screen.queryByRole("radiogroup")).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: /技能/ })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /添加附件.*图片/ }),
    ).toBeEnabled();
  });
});

it("supports searchable context keyboard selection, Back navigation and actual overlay notifications", async () => {
  vi.spyOn(agentRuntimeApi, "listReferenceOptions").mockResolvedValue({
    items: [
      { kind: "file", id: "already.md", label: "Already added" },
      { kind: "file", id: "src/new.ts", label: "New file", recent: true },
    ],
  });
  const user = userEvent.setup(), changed = vi.fn(), overlay = vi.fn(), opened = vi.fn();
  render(<ComposerContextPicker {...props} references={[{ kind: "file", id: "already.md" }]} onChange={changed} onOpen={opened} onOpenChange={overlay} />);
  await open();
  await user.click(screen.getByRole("button", { name: "项目文件" }));
  expect(await screen.findByRole("option", { name: /Already added/ })).toHaveAttribute("aria-disabled", "true");
  await user.click(screen.getByRole("button", { name: "返回上下文类型" }));
  expect(screen.getByRole("button", { name: "项目文件" })).toBeVisible();
  expect(opened).toHaveBeenCalledOnce();
  expect(overlay).toHaveBeenLastCalledWith(true);
  await user.click(screen.getByRole("button", { name: "项目文件" }));
  const option = await screen.findByRole("option", { name: /New file/ });
  const search = screen.getByRole("combobox", { name: "搜索上下文" });
  await user.keyboard("{ArrowDown}");
  await waitFor(() => expect(search).toHaveAttribute("aria-activedescendant", option.id));
  await user.keyboard("{Enter}");
  expect(changed).toHaveBeenCalledWith([{ kind: "file", id: "already.md" }, { kind: "file", id: "src/new.ts", label: "New file" }]);
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  expect(screen.getByRole("button", { name: "添加附件、上下文或切换模式" })).toHaveFocus();
  expect(overlay.mock.calls).toEqual([[false], [true], [false]]);
});
