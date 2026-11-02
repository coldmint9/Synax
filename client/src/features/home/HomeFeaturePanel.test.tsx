import { fireEvent, render, screen, within } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { HomeFeaturePanel } from "./HomeFeaturePanel";
import { QUICK_ACTIONS, QUICK_ACTION_PINNED_IDS, type QuickAction } from "../quick-actions/quickActions";

const openCatalog = (name = "More") => fireEvent.click(screen.getByRole("button", { name }));

describe("home feature dock", () => {
  it("shows the four pinned shortcuts until the catalog is opened", () => {
    render(<MemoryRouter><HomeFeaturePanel locale="zh" onLaunch={vi.fn()} onAttach={vi.fn()} /></MemoryRouter>);
    const dock = screen.getByRole("list", { name: "主推功能" });
    expect(within(dock).getAllByRole("button").map((button) => button.querySelector("strong")?.textContent))
      .toEqual(["可视化图解", "排查问题", "审查改动", "上线前检查"]);
    expect(QUICK_ACTION_PINNED_IDS).toHaveLength(4);
    expect(screen.queryByRole("button", { name: "全部" })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /理解项目/ })).not.toBeInTheDocument();

    const toggle = screen.getByRole("button", { name: "更多" });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    fireEvent.click(toggle);

    expect(screen.getByRole("button", { name: "全部" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /理解项目/ })).toBeEnabled();
    const collapse = screen.getByRole("button", { name: "收起" });
    expect(collapse).toHaveAttribute("aria-expanded", "true");
    fireEvent.click(collapse);
    expect(screen.queryByRole("button", { name: /理解项目/ })).not.toBeInTheDocument();
    expect(within(dock).getAllByRole("button")).toHaveLength(4);
  });


  it("filters the extensible catalog by category", () => {
    const custom: QuickAction = {
      ...QUICK_ACTIONS[0]!, id: "database",
      title: { zh: "查询优化", en: "Query tuning" },
      description: { zh: "分析慢查询", en: "Analyze slow queries" },
    };
    render(<MemoryRouter><HomeFeaturePanel locale="zh" actions={[...QUICK_ACTIONS, custom]} onLaunch={vi.fn()} /></MemoryRouter>);
    openCatalog("更多");
    expect(screen.queryByRole("searchbox")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "质量", exact: true }));
    expect(screen.getByRole("button", { name: /补充测试/ })).toBeEnabled();
    expect(screen.queryByRole("button", { name: /查询优化/ })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "全部", exact: true }));
    expect(screen.getByRole("button", { name: /查询优化/ })).toBeEnabled();
  });

  it("starts the action's session and disables launch while unavailable", () => {
    const view = render(<MemoryRouter><HomeFeaturePanel locale="en" /></MemoryRouter>);
    openCatalog();
    expect(screen.getByRole("button", { name: /Explore project/ })).toBeDisabled();

    const launch = vi.fn();
    view.rerender(<MemoryRouter><HomeFeaturePanel locale="en" onLaunch={launch} /></MemoryRouter>);
    fireEvent.click(screen.getByRole("button", { name: /Explore project/ }));
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({
      actionId: "project-onboarding",
      mode: "chat",
      skillIds: ["synax-builtin/project-onboarding", "synax-builtin/visualize"],
      text: expect.stringContaining("read-only"),
    }));
    expect(launch.mock.calls[0]![0].text).toContain("Skills attached to this session");

    view.rerender(<MemoryRouter><HomeFeaturePanel locale="en" onLaunch={launch} launchDisabled /></MemoryRouter>);
    expect(screen.getByRole("button", { name: /Explore project/ })).toBeDisabled();
  });

  it("shows how many skills each shortcut orchestrates", () => {
    render(<MemoryRouter><HomeFeaturePanel locale="en" onLaunch={vi.fn()} /></MemoryRouter>);
    const gate = screen.getByRole("button", { name: /Release gate/ });
    expect(gate).toHaveTextContent("4");
    expect(gate).toHaveAccessibleName(/Release gate/);
    expect(gate).toHaveAccessibleName(/Release gate \+ Code review \+ Test augmentation/);
  });

  it("moves focus through the grid with arrow keys", () => {
    render(<MemoryRouter><HomeFeaturePanel locale="en" onLaunch={vi.fn()} onAttach={vi.fn()} /></MemoryRouter>);
    openCatalog();
    const first = screen.getByRole("button", { name: /Explore project/ });
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight" });
    expect(screen.getByRole("button", { name: /Plan a feature/ })).toHaveFocus();
    fireEvent.keyDown(document.activeElement as HTMLElement, { key: "ArrowLeft" });
    expect(first).toHaveFocus();
  });

  it("attaches procedures that need user input instead of starting them", () => {
    const launch = vi.fn();
    const attach = vi.fn();
    render(<MemoryRouter><HomeFeaturePanel locale="en" onLaunch={launch} onAttach={attach} /></MemoryRouter>);
    const card = screen.getByRole("button", { name: /Investigate a bug/ });
    expect(card).toBeEnabled();
    fireEvent.click(card);
    expect(launch).not.toHaveBeenCalled();
    expect(attach).toHaveBeenCalledWith(expect.objectContaining({
      actionId: "diagnose",
      requiresInput: true,
      hint: "observed behavior, reproduction steps and expectations",
      skillIds: ["synax-builtin/systematic-debugging", "synax-builtin/synax-explore"],
    }));

    // The visual explainer stays armed for whatever question is typed next.
    fireEvent.click(screen.getByRole("button", { name: /Visual explainer/ }));
    expect(launch).not.toHaveBeenCalled();
    expect(attach).toHaveBeenLastCalledWith(expect.objectContaining({
      actionId: "visual-explainer",
      requiresInput: true,
      skillIds: ["synax-builtin/visualize"],
    }));
  });

  it("keeps the launching card busy while the session starts", () => {
    render(<MemoryRouter><HomeFeaturePanel locale="en" onLaunch={vi.fn()} launchingId="code-review" launchDisabled /></MemoryRouter>);
    const card = screen.getByRole("button", { name: /Review changes/ });
    expect(card).toBeDisabled();
    expect(card).toHaveAttribute("aria-busy", "true");
    expect(screen.getByText("Starting Review changes")).toBeInTheDocument();
  });
});
