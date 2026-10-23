import { beforeEach, expect, it, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { SessionListPanel } from "../SessionListPanel";
import { useShellStore } from "../../../shared/state/shellStore";

const noop = () => {};

vi.mock("react-router-dom", () => ({
  useNavigate: () => vi.fn(),
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
}));

vi.mock("../useSessionList", () => ({
  useSessionList: () => ({
    ensureLoaded: noop,
    isProjectReady: true,
    searchQuery: "",
    setSearchQuery: noop,
    groups: [],
    viewCounts: { workflow: 0 },
    hasMore: false,
    isLoading: false,
    error: null,
    selectedId: null,
    isLoadingMore: false,
    hasPinned: false,
    select: noop,
    toggleGroup: noop,
    toggleExpand: noop,
    togglePin: noop,
    loadMore: noop,
    openNewDraft: noop,
    deleteSession: async () => [],
    refresh: async () => {},
  }),
}));

vi.mock("../SessionToolbarPortal", () => ({
  SessionToolbarContent: ({ children }: { children: React.ReactNode }) => (
    <>{children}</>
  ),
}));

vi.mock("../WorkspaceDirectoryTree", () => ({
  WorkspaceDirectoryTree: () => <nav aria-label="工作区目录树" />,
}));

beforeEach(() => {
  useShellStore.setState((state) => ({
    preferences: { ...state.preferences, locale: "zh" },
  }));
});

it("renders the workspace tree without an empty page header", () => {
  const { container } = render(
    <SessionListPanel projectId="p" sidebarView="workspace" />,
  );

  expect(screen.getByRole("navigation", { name: "工作区目录树" })).toBeTruthy();
  expect(container.querySelector(".session-list-header")).toBeNull();
});

it("keeps the session list header in the session view", () => {
  const { container } = render(<SessionListPanel projectId="p" />);

  expect(container.querySelector(".session-list-header")).toBeTruthy();
  expect(container.querySelector(".session-list-titlebar-row")).toBeTruthy();
});
