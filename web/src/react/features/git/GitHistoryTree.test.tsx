import { render, screen, within, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { GitWorkspaceSummary } from "../../../lib/api/project";
import GitHistoryTree from "./GitHistoryTree";
import { ContextMenuProvider } from "../../components/context-menu/ContextMenuProvider";
import { MemoryRouter } from "react-router-dom";

const workspace: GitWorkspaceSummary = {
  repositoryRoot: "/fixture/repo",
  defaultPath: "/fixture/repo",
  branches: [],
  worktrees: [],
  commits: [
    {
      id: "merge1",
      parents: ["left", "right"],
      subject: "Merge UI",
      author: "Alex",
      authoredAt: "2026-09-26T00:00:00Z",
      refs: ["main"],
      rebase: false,
    },
    {
      id: "left",
      parents: [],
      subject: "Improve inputs",
      author: "Casey",
      authoredAt: "2026-09-25T00:00:00Z",
      refs: [],
      rebase: false,
    },
  ],
};

describe("Git history table", () => {
  it("renders a compact table including commit ID and opens commit details by keyboard", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <MemoryRouter>
        <ContextMenuProvider>
          <GitHistoryTree workspace={workspace} />
        </ContextMenuProvider>
      </MemoryRouter>,
    );
    const table = screen.getByRole("table", { name: "Git 提交历史" });
    expect(within(table).getAllByRole("columnheader")).toHaveLength(6);
    expect(
      within(table).getByRole("columnheader", { name: "Commit ID" }),
    ).toBeInTheDocument();
    expect(
      within(table).getByRole("columnheader", { name: "操作" }),
    ).toBeInTheDocument();
    const select = within(table).getByRole("button", {
      name: "Improve inputs",
    });
    select.focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("complementary")).toHaveTextContent(
      "Improve inputs",
    );
    expect(within(table).getAllByRole("row")).toHaveLength(3);
    expect(container.querySelector(".history-tree-rail")).toHaveAttribute(
      "height",
      "120",
    );
  });

  it("preserves merge filtering and search without a component-library table", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <MemoryRouter>
        <ContextMenuProvider>
          <GitHistoryTree workspace={workspace} />
        </ContextMenuProvider>
      </MemoryRouter>,
    );
    await user.click(screen.getByRole("button", { name: "合并提交" }));
    expect(screen.getByRole("button", { name: "合并提交" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    expect(
      screen.queryByRole("button", { name: "Improve inputs" }),
    ).not.toBeInTheDocument();
    expect(container.querySelector(".history-tree-rail")).toHaveAttribute(
      "height",
      "60",
    );
    await user.click(screen.getByRole("button", { name: "全部" }));
    await user.type(
      screen.getByRole("textbox", { name: "搜索提交、分支或作者" }),
      "Casey",
    );
    expect(
      screen.getByRole("button", { name: "Improve inputs" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Merge UI" }),
    ).not.toBeInTheDocument();
    await user.type(
      screen.getByRole("textbox", { name: "搜索提交、分支或作者" }),
      " no match",
    );
    expect(container.querySelector(".history-tree-rail")).toBeNull();
  });

  it("closes the inspector with Escape, restores focus, and preserves scroll", async () => {
    const user = userEvent.setup();
    const { container } = render(
      <MemoryRouter>
        <ContextMenuProvider>
          <GitHistoryTree workspace={workspace} />
        </ContextMenuProvider>
      </MemoryRouter>,
    );
    const viewport = container.querySelector(".history-tree-viewport")!;
    viewport.scrollTop = 180;
    const trigger = screen.getByRole("button", {
      name: "Improve inputs",
      exact: true,
    });
    await user.click(trigger);
    expect(screen.getByRole("button", { name: "关闭提交详情" })).toHaveFocus();
    expect(viewport.scrollTop).toBe(180);
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("complementary")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
    expect(viewport.scrollTop).toBe(180);
  });

  it("supports arrow navigation and does not steal slash while typing in search", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ContextMenuProvider>
          <GitHistoryTree workspace={workspace} />
        </ContextMenuProvider>
      </MemoryRouter>,
    );
    const first = screen.getByRole("button", { name: "Merge UI", exact: true });
    first.focus();
    await user.keyboard("{ArrowDown}");
    expect(
      screen.getByRole("button", { name: "Improve inputs", exact: true }),
    ).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(first).toHaveFocus();
    await user.keyboard("/");
    const search = screen.getByRole("textbox", {
      name: "搜索提交、分支或作者",
    });
    expect(search).toHaveFocus();
    await user.type(search, "feature/");
    expect(search).toHaveValue("feature/");
    expect(screen.getByText("没有匹配的提交")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "清除筛选" }));
    expect(search).toHaveFocus();
    expect(search).toHaveValue("");
    expect(first).not.toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Merge UI", exact: true }),
    ).toBeInTheDocument();
  });

  it("allows opening details from a focused row and moving through filtered commits", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ContextMenuProvider>
          <GitHistoryTree workspace={workspace} />
        </ContextMenuProvider>
      </MemoryRouter>,
    );
    screen
      .getByRole("button", { name: "Merge UI", exact: true })
      .closest("tr")!
      .focus();
    await user.keyboard("{Enter}");
    expect(screen.getByRole("complementary")).toHaveTextContent("Merge UI");
    expect(screen.getByRole("button", { name: "上一个提交" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "下一个提交" }));
    expect(screen.getByRole("complementary")).toHaveTextContent(
      "Improve inputs",
    );
    expect(screen.getByRole("button", { name: "下一个提交" })).toBeDisabled();
    await user.click(screen.getByRole("button", { name: "上一个提交" }));
    expect(screen.getByRole("complementary")).toHaveTextContent("Merge UI");
  });

  it("folds refs without removing access to local, remote and tag actions", async () => {
    const user = userEvent.setup();
    const withRefs = {
      ...workspace,
      commits: [
        {
          ...workspace.commits[0],
          refs: ["refs/heads/main", "refs/remotes/origin/main", "refs/tags/v1"],
        },
      ],
    };
    render(
      <MemoryRouter>
        <ContextMenuProvider>
          <GitHistoryTree workspace={withRefs} />
        </ContextMenuProvider>
      </MemoryRouter>,
    );
    expect(
      screen.queryByRole("button", { name: "origin/main", exact: true }),
    ).not.toBeInTheDocument();
    const trigger = screen.getByRole("button", { name: "查看另外 2 个引用" });
    await user.click(trigger);
    expect(
      screen.getByRole("button", { name: "origin/main", exact: true }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "v1", exact: true }),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");
    expect(screen.queryByText("此提交的引用")).not.toBeInTheDocument();
    expect(trigger).toHaveFocus();
  });

  it("exposes row actions without requiring a right-click", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ContextMenuProvider>
          <GitHistoryTree workspace={workspace} />
        </ContextMenuProvider>
      </MemoryRouter>,
    );
    await user.click(
      screen.getByRole("button", { name: "提交操作：Improve inputs" }),
    );
    expect(
      screen.getByRole("menuitem", { name: "查看提交详情" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("menuitem", { name: "Cherry-pick 到当前分支…" }),
    ).toBeInTheDocument();
    await user.keyboard("{Escape}");
  });

  it("copies the full commit ID with explicit feedback", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ContextMenuProvider>
          <GitHistoryTree workspace={workspace} />
        </ContextMenuProvider>
      </MemoryRouter>,
    );
    await user.click(
      screen.getByRole("button", { name: "Improve inputs", exact: true }),
    );
    await user.click(screen.getByRole("button", { name: "复制 Commit ID" }));
    expect(await navigator.clipboard.readText()).toBe("left");
    expect(screen.getByText("已复制 Commit ID")).toBeInTheDocument();
  });

  it("returns focus to search if filtering removed the original detail trigger", async () => {
    const user = userEvent.setup();
    render(
      <MemoryRouter>
        <ContextMenuProvider>
          <GitHistoryTree workspace={workspace} />
        </ContextMenuProvider>
      </MemoryRouter>,
    );
    await user.click(
      screen.getByRole("button", { name: "Improve inputs", exact: true }),
    );
    const search = screen.getByRole("textbox", {
      name: "搜索提交、分支或作者",
    });
    fireEvent.change(search, { target: { value: "not-found" } });
    await user.click(screen.getByRole("button", { name: "关闭提交详情" }));
    expect(search).toHaveFocus();
  });
});
