import { useState } from "react";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  listRemoteDirectories,
  type RemoteDirectoryListing,
} from "../../../lib/api/fs";
import { DirectoryPickerDialog } from "./DirectoryPickerDialog";

vi.mock("../../../lib/api/fs", () => ({
  listRemoteDirectories: vi.fn(),
}));

function listing(
  overrides: Partial<RemoteDirectoryListing> = {},
): RemoteDirectoryListing {
  return {
    path: "/home/dev",
    name: "dev",
    parent: "/home",
    home: "/home/dev",
    shortcuts: [],
    entries: [
      { name: "work", path: "/home/dev/work", hidden: false },
      { name: ".config", path: "/home/dev/.config", hidden: true },
    ],
    truncated: false,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("DirectoryPickerDialog", () => {
  beforeEach(() => {
    vi.mocked(listRemoteDirectories).mockReset();
  });

  it("lists the initial directory on open and returns the chosen absolute path", async () => {
    vi.mocked(listRemoteDirectories).mockResolvedValue(listing());
    const onSelect = vi.fn();

    render(
      <DirectoryPickerDialog
        open
        initialPath="/home/dev"
        onClose={vi.fn()}
        onSelect={onSelect}
      />,
    );

    expect(
      await screen.findByRole("button", { name: /work/ }),
    ).toBeInTheDocument();
    expect(listRemoteDirectories).toHaveBeenCalledWith(
      "/home/dev",
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(
      screen.queryByRole("checkbox", { name: "选择 work" }),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole("dialog").closest(".dialog-overlay")?.parentElement,
    ).toBe(document.body);
    expect(screen.getByRole("region", { name: "选择项目目录" })).toHaveClass(
      "overflow-y-auto",
    );

    fireEvent.click(screen.getByRole("button", { name: "选择此目录" }));
    expect(onSelect).toHaveBeenCalledWith({ path: "/home/dev", name: "dev" });
    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  it("descends into an entry and confirms the new path", async () => {
    vi.mocked(listRemoteDirectories)
      .mockResolvedValueOnce(listing())
      .mockResolvedValueOnce(
        listing({
          path: "/home/dev/work",
          name: "work",
          parent: "/home/dev",
          entries: [],
        }),
      );
    const onSelect = vi.fn();

    render(
      <DirectoryPickerDialog
        open
        initialPath="/home/dev"
        onClose={vi.fn()}
        onSelect={onSelect}
      />,
    );

    fireEvent.click(await screen.findByRole("button", { name: /work/ }));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "目录路径" })).toHaveValue(
        "/home/dev/work",
      ),
    );

    fireEvent.click(screen.getByRole("button", { name: "选择此目录" }));
    expect(onSelect).toHaveBeenCalledWith({
      path: "/home/dev/work",
      name: "work",
    });
  });

  it("surfaces a listing failure without discarding the dialog", async () => {
    vi.mocked(listRemoteDirectories).mockRejectedValueOnce(
      new Error("Directory not found: /home/ghost"),
    );

    render(
      <DirectoryPickerDialog
        open
        initialPath="/home/ghost"
        onClose={vi.fn()}
        onSelect={vi.fn()}
      />,
    );

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Directory not found: /home/ghost",
    );
    expect(screen.getByRole("button", { name: "选择此目录" })).toBeDisabled();
  });

  it("re-requests with hidden directories enabled", async () => {
    vi.mocked(listRemoteDirectories).mockResolvedValue(listing());

    render(
      <DirectoryPickerDialog
        open
        initialPath="/home/dev"
        onClose={vi.fn()}
        onSelect={vi.fn()}
      />,
    );
    await screen.findByRole("button", { name: /work/ });

    fireEvent.click(screen.getByLabelText("显示隐藏目录"));

    await waitFor(() =>
      expect(listRemoteDirectories).toHaveBeenLastCalledWith(
        "/home/dev",
        expect.objectContaining({ showHidden: true }),
      ),
    );
  });

  it("closes on Escape", async () => {
    vi.mocked(listRemoteDirectories).mockResolvedValue(listing());
    const onClose = vi.fn();

    render(
      <DirectoryPickerDialog
        open
        initialPath="/home/dev"
        onClose={onClose}
        onSelect={vi.fn()}
      />,
    );
    await screen.findByRole("button", { name: /work/ });

    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });

  it("keeps selections across navigation and filtering and toggles the current directory without duplicates", async () => {
    vi.mocked(listRemoteDirectories).mockImplementation(async (path) =>
      path === "/home/dev/work"
        ? listing({
            path,
            name: "work",
            parent: "/home/dev",
            entries: [
              { name: "package", path: `${path}/package`, hidden: false },
            ],
          })
        : listing(),
    );
    const onSelect = vi.fn();
    const onSelectMultiple = vi.fn();
    render(
      <DirectoryPickerDialog
        open
        multiple
        onClose={vi.fn()}
        onSelect={onSelect}
        onSelectMultiple={onSelectMultiple}
        labels={{ confirm: "导入目录" }}
      />,
    );

    expect(screen.getByRole("button", { name: "导入目录 (0)" })).toBeDisabled();
    fireEvent.click(await screen.findByRole("checkbox", { name: "选择 work" }));
    fireEvent.click(screen.getByRole("button", { name: "work" }));
    fireEvent.click(
      await screen.findByRole("checkbox", { name: "选择 package" }),
    );
    expect(screen.getByRole("status")).toHaveTextContent("已选择 2 个项目");

    fireEvent.click(screen.getByRole("button", { name: "取消选择当前目录" }));
    expect(screen.getByRole("status")).toHaveTextContent("已选择 1 个项目");
    fireEvent.click(screen.getByRole("button", { name: "选择当前目录" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "显示构建目录" }));
    expect(
      await screen.findByRole("checkbox", { name: "选择 package" }),
    ).toBeChecked();
    expect(listRemoteDirectories).toHaveBeenLastCalledWith(
      "/home/dev/work",
      expect.objectContaining({ showIgnored: true }),
    );

    fireEvent.click(screen.getByRole("button", { name: "主目录" }));
    expect(
      await screen.findByRole("checkbox", { name: "选择 work" }),
    ).toBeChecked();
    fireEvent.click(screen.getByRole("button", { name: "导入目录 (2)" }));
    expect(onSelectMultiple).toHaveBeenCalledExactlyOnceWith([
      { path: "/home/dev/work/package", name: "package" },
      { path: "/home/dev/work", name: "work" },
    ]);
    expect(onSelect).not.toHaveBeenCalled();
  });

  it("keeps selected directories available for confirmation after a navigation error", async () => {
    vi.mocked(listRemoteDirectories)
      .mockResolvedValueOnce(listing())
      .mockRejectedValueOnce(new Error("Permission denied"));
    const onSelectMultiple = vi.fn();
    render(
      <DirectoryPickerDialog
        open
        multiple
        onClose={vi.fn()}
        onSelect={vi.fn()}
        onSelectMultiple={onSelectMultiple}
      />,
    );
    fireEvent.click(await screen.findByRole("checkbox", { name: "选择 work" }));
    fireEvent.click(screen.getByRole("button", { name: "work" }));

    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Permission denied",
    );
    expect(screen.getByRole("status")).toHaveTextContent("已选择 1 个项目");
    expect(screen.getByRole("button", { name: "选择当前目录" })).toBeDisabled();
    fireEvent.click(screen.getByRole("button", { name: "添加所选项目 (1)" }));
    expect(onSelectMultiple).toHaveBeenCalledExactlyOnceWith([
      { path: "/home/dev/work", name: "work" },
    ]);
  });

  it("clears selections, filters and navigation on cancel and reopen, and restores focus", async () => {
    vi.mocked(listRemoteDirectories).mockImplementation(async (path) =>
      path === "/home/dev/work"
        ? listing({ path, name: "work", parent: "/home/dev", entries: [] })
        : listing(),
    );
    const onSelectMultiple = vi.fn();
    function Harness() {
      const [open, setOpen] = useState(false);
      return (
        <>
          <button onClick={() => setOpen(true)}>打开目录</button>
          <DirectoryPickerDialog
            open={open}
            multiple
            onClose={() => setOpen(false)}
            onSelect={vi.fn()}
            onSelectMultiple={onSelectMultiple}
          />
        </>
      );
    }
    const user = userEvent.setup();
    render(<Harness />);
    const trigger = screen.getByRole("button", { name: "打开目录" });
    await user.click(trigger);
    fireEvent.click(await screen.findByRole("checkbox", { name: "选择 work" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "显示隐藏目录" }));
    fireEvent.click(await screen.findByRole("button", { name: "work" }));
    await waitFor(() =>
      expect(screen.getByRole("textbox", { name: "目录路径" })).toHaveValue(
        "/home/dev/work",
      ),
    );
    await user.click(screen.getByRole("button", { name: "取消" }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(onSelectMultiple).not.toHaveBeenCalled();

    await user.click(trigger);
    expect(
      await screen.findByRole("checkbox", { name: "选择 work" }),
    ).not.toBeChecked();
    expect(
      screen.getByRole("checkbox", { name: "显示隐藏目录" }),
    ).not.toBeChecked();
    expect(screen.getByRole("textbox", { name: "目录路径" })).toHaveValue(
      "/home/dev",
    );
    expect(screen.getByRole("textbox", { name: "目录路径" })).toHaveFocus();
    expect(
      screen.getByRole("button", { name: "添加所选项目 (0)" }),
    ).toBeDisabled();

    const close = screen.getByRole("button", { name: "关闭" });
    close.focus();
    await user.tab({ shift: true });
    expect(screen.getByRole("button", { name: "取消" })).toHaveFocus();
    await user.tab();
    expect(close).toHaveFocus();
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it.each(["resolve", "reject"] as const)(
    "ignores a stale listing %s after closing and reopening",
    async (outcome) => {
      const old = deferred<RemoteDirectoryListing>();
      vi.mocked(listRemoteDirectories)
        .mockReturnValueOnce(old.promise)
        .mockResolvedValueOnce(
          listing({ path: "/fresh", name: "fresh", entries: [] }),
        );
      const props = { onClose: vi.fn(), onSelect: vi.fn() };
      const view = render(
        <DirectoryPickerDialog open initialPath="/old" {...props} />,
      );
      const signal = vi.mocked(listRemoteDirectories).mock.calls[0][1]?.signal;
      view.rerender(
        <DirectoryPickerDialog open={false} initialPath="/old" {...props} />,
      );
      expect(signal?.aborted).toBe(true);
      view.rerender(
        <DirectoryPickerDialog open initialPath="/fresh" {...props} />,
      );
      await waitFor(() =>
        expect(screen.getByRole("textbox", { name: "目录路径" })).toHaveValue(
          "/fresh",
        ),
      );
      await act(async () => {
        if (outcome === "resolve") old.resolve(listing());
        else old.reject(new Error("old failure"));
      });

      expect(screen.getByRole("textbox", { name: "目录路径" })).toHaveValue(
        "/fresh",
      );
      expect(screen.queryByRole("alert")).not.toBeInTheDocument();
      fireEvent.click(screen.getByRole("button", { name: "选择此目录" }));
      expect(props.onSelect).toHaveBeenCalledExactlyOnceWith({
        path: "/fresh",
        name: "fresh",
      });
    },
  );

  it("ignores an older navigation response even if the transport does not honor abort", async () => {
    const slow = deferred<RemoteDirectoryListing>();
    vi.mocked(listRemoteDirectories)
      .mockResolvedValueOnce(listing())
      .mockReturnValueOnce(slow.promise)
      .mockResolvedValueOnce(
        listing({ path: "/fast", name: "fast", entries: [] }),
      );
    render(<DirectoryPickerDialog open onClose={vi.fn()} onSelect={vi.fn()} />);
    await screen.findByRole("button", { name: "work" });
    const input = screen.getByRole("textbox", { name: "目录路径" });
    fireEvent.change(input, { target: { value: "/slow" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(screen.getByRole("button", { name: "选择此目录" })).toBeDisabled();
    const signal = vi.mocked(listRemoteDirectories).mock.calls[1][1]?.signal;
    fireEvent.change(input, { target: { value: "/fast" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(screen.getByRole("button", { name: "选择此目录" })).toBeEnabled(),
    );
    expect(signal?.aborted).toBe(true);
    await act(async () => {
      slow.resolve(listing({ path: "/slow", name: "slow" }));
    });
    expect(input).toHaveValue("/fast");
    expect(
      screen.queryByRole("button", { name: "work" }),
    ).not.toBeInTheDocument();
  });
});
