import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import type { ComponentProps } from "react";
import type { SessionGroup, SessionTreeNode } from "../useSessionList";
import { SessionTimeGroups } from "../SessionTimeGroups";

vi.mock("../../../shared/hooks/useLocale", () => ({ useLocale: () => ({ locale: "zh" }) }));
vi.mock("../SessionTreeItem", () => ({ SessionTreeItem: ({ node }: { node: SessionTreeNode }) => <button className="session-list-item" data-session={node.session.id}>{node.session.id}</button> }));
vi.mock("../SynaxWordmark", () => ({ SynaxWordmark: () => <span>Synax</span> }));

const group = (count: number, key = "sessions"): SessionGroup => ({
  key, label: key, count, collapsed: false,
  sessions: Array.from({ length: count }, (_, i) => ({ session: { id: `${key}-${i}` }, depth: 0, children: [], expanded: false }) as SessionTreeNode),
});
const props = (overrides: Partial<ComponentProps<typeof SessionTimeGroups>> = {}): ComponentProps<typeof SessionTimeGroups> => ({
  groups: [group(45)], selectedId: null, isLoadingMore: false, hasMore: false,
  onSelect: vi.fn(), onToggleGroup: vi.fn(), onToggleExpand: vi.fn(), onLoadMore: vi.fn(), onDelete: vi.fn(), ...overrides,
});
const rows = (container: HTMLElement) => container.querySelectorAll("[data-session]");
const expand = () => screen.getByRole("button", { name: /展开更多/ });

it("starts with 20 total rows across pinned and ordinary groups", () => {
  const { container } = render(<SessionTimeGroups {...props({ groups: [group(8, "pinned:sessions"), group(30)] })} />);
  expect(rows(container)).toHaveLength(20);
  expect(screen.queryByText("sessions-12")).toBeNull();
});

it("never loads or reveals another page merely from scrolling", () => {
  const input = props({ hasMore: true });
  const { container } = render(<SessionTimeGroups {...input} />);
  fireEvent.scroll(container.querySelector(".session-list-groups")!);
  expect(rows(container)).toHaveLength(20);
  expect(input.onLoadMore).not.toHaveBeenCalled();
});

it("reveals cached rows in batches of 20 and animates only the added rows", () => {
  const input = props();
  const { container } = render(<SessionTimeGroups {...input} />);
  const first = rows(container)[0];
  expect(container.querySelectorAll('[data-revealing="true"]')).toHaveLength(0);
  fireEvent.click(expand());
  expect(rows(container)).toHaveLength(40);
  expect(rows(container)[0]).toBe(first);
  expect(container.querySelectorAll('[data-revealing="true"]')).toHaveLength(20);
  container.querySelectorAll('[data-revealing="true"]').forEach((node) => fireEvent.animationEnd(node));
  expect(container.querySelectorAll('[data-revealing="true"]')).toHaveLength(0);
  fireEvent.click(expand());
  expect(rows(container)).toHaveLength(45);
  expect(container.querySelectorAll('[data-revealing="true"]')).toHaveLength(5);
  expect(screen.queryByRole("button", { name: /展开更多/ })).toBeNull();
  expect(input.onLoadMore).not.toHaveBeenCalled();
});

it("fetches exactly once per pending click and reveals the arriving page", async () => {
  let finish!: () => void;
  const request = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const input = props({ groups: [group(20)], hasMore: true, onLoadMore: request });
  const { container, rerender } = render(<SessionTimeGroups {...input} />);
  fireEvent.click(expand());
  expect(screen.getByRole("button", { name: /正在加载/ })).toBeDisabled();
  fireEvent.click(screen.getByRole("button", { name: /正在加载/ }));
  expect(request).toHaveBeenCalledTimes(1);
  rerender(<SessionTimeGroups {...input} groups={[group(40)]} />);
  await act(async () => finish());
  expect(rows(container)).toHaveLength(40);
  expect(container.querySelectorAll('[data-revealing="true"]')).toHaveLength(20);
});

it("keeps the existing rows on failure and retries the same next page", async () => {
  const request = vi.fn().mockRejectedValueOnce(new Error("offline")).mockResolvedValueOnce(undefined);
  const input = props({ groups: [group(20)], hasMore: true, onLoadMore: request });
  const { container, rerender } = render(<SessionTimeGroups {...input} />);
  fireEvent.click(expand());
  await screen.findByRole("alert");
  expect(rows(container)).toHaveLength(20);
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  rerender(<SessionTimeGroups {...input} groups={[group(60)]} />);
  expect(rows(container)).toHaveLength(40); // A failed attempt does not reserve an extra page.
});

it("offers expansion when the current page contains no matching sessions", async () => {
  const input = props({ groups: [], hasMore: true, onLoadMore: vi.fn(async () => {}) });
  render(<SessionTimeGroups {...input} />);
  fireEvent.click(expand());
  await waitFor(() => expect(input.onLoadMore).toHaveBeenCalledTimes(1));
});

it("returns to 20 visible rows when the workspace or search key changes", () => {
  const input = props();
  const { container, rerender } = render(<SessionTimeGroups key="first" {...input} />);
  fireEvent.click(expand());
  expect(rows(container)).toHaveLength(40);
  rerender(<SessionTimeGroups key="new-query" {...input} />);
  expect(rows(container)).toHaveLength(20);
});

it("retries an API-store page error via load-more instead of refreshing page one", async () => {
  const request = vi.fn(async () => {});
  const refresh = vi.fn();
  const input = props({ groups: [group(20)], hasMore: true, onLoadMore: request, onRetry: refresh });
  const { rerender } = render(<SessionTimeGroups {...input} />);
  fireEvent.click(expand());
  await waitFor(() => expect(request).toHaveBeenCalledTimes(1));
  rerender(<SessionTimeGroups {...input} error="offline" />);
  fireEvent.click(screen.getByRole("button", { name: "重试" }));
  await waitFor(() => expect(request).toHaveBeenCalledTimes(2));
  expect(refresh).not.toHaveBeenCalled();
});

it("renders expansion immediately without animation or clipped shadows under reduced motion", () => {
  const spy = vi.spyOn(window, "matchMedia").mockReturnValue({ matches: true, addEventListener: vi.fn(), removeEventListener: vi.fn() } as unknown as MediaQueryList);
  try {
    const { container } = render(<SessionTimeGroups {...props()} />);
    fireEvent.click(expand());
    expect(rows(container)).toHaveLength(40);
    expect(container.querySelectorAll('[data-revealing="true"]')).toHaveLength(0);
  } finally { spy.mockRestore(); }
});

it("never collapses ordinary sessions, even with a stale collapsed flag", () => {
  const input = props({ groups: [{ ...group(1, "pinned:sessions"), collapsed: true }, { ...group(25), collapsed: true }] });
  const { container } = render(<SessionTimeGroups {...input} />);
  expect(container.querySelectorAll(".session-list-section-toggle")).toHaveLength(1);
  const label = container.querySelector(".session-list-section-label")!;
  expect(label.tagName).toBe("DIV");
  expect(label.querySelector("svg")).toBeNull();
  fireEvent.click(label);
  expect(input.onToggleGroup).not.toHaveBeenCalled();
  const ordinary = label.parentElement!.querySelector(".session-list-section-content")!;
  expect(ordinary).toHaveAttribute("data-collapsed", "false");
  expect(ordinary).not.toHaveAttribute("inert");
  expect(expand()).toBeEnabled();
  expect(container.querySelector(".lucide-pin")).toBeNull();
});
