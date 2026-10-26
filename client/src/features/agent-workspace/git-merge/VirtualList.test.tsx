import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { VirtualList } from "./VirtualList";
import { VirtualEvents } from "./VirtualEvents";
const items = Array.from({ length: 2000 }, (_, index) => ({
  id: `item-${index}`,
  title: `Record ${index}`,
}));
function List({ rows = items }: { rows?: typeof items }) {
  return (
    <VirtualList
      items={rows}
      label="Test list"
      rowHeight={36}
      maxHeight={252}
      getKey={(item) => item.id}
      renderRow={(item) => <button>{item.title}</button>}
    />
  );
}
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
describe("bounded native task list windows", () => {
  it("mounts only the visible rows and overscan, then replaces them on scroll", async () => {
    render(<List />);
    const viewport = screen.getByRole("region", { name: "Test list" });
    expect(viewport.style.height).toBe("252px");
    expect(
      within(viewport).getAllByRole("listitem").length,
    ).toBeLessThanOrEqual(13);
    expect(screen.queryByText("Record 1000")).toBeNull();
    viewport.scrollTop = 1000 * 36;
    fireEvent.scroll(viewport);
    await screen.findByText("Record 1000");
    expect(screen.queryByText("Record 0")).toBeNull();
    expect(
      within(viewport).getAllByRole("listitem").length,
    ).toBeLessThanOrEqual(13);
    expect(screen.getByText("Record 1000").closest("li")).toHaveAttribute(
      "aria-setsize",
      "2000",
    );
  });
  it("makes the last offscreen row keyboard reachable and clamps after data shrinks", async () => {
    const { rerender } = render(<List />);
    const viewport = screen.getByRole("region", { name: "Test list" });
    fireEvent.keyDown(viewport, { key: "End" });
    expect(
      await screen.findByRole("button", { name: "Record 1999" }),
    ).toHaveFocus();
    fireEvent.keyDown(document.activeElement!, { key: "Home" });
    expect(
      await screen.findByRole("button", { name: "Record 0" }),
    ).toHaveFocus();
    viewport.scrollTop = 50000;
    fireEvent.scroll(viewport);
    await waitFor(() => expect(screen.queryByText("Record 0")).toBeNull());
    rerender(<List rows={items.slice(0, 3)} />);
    expect(viewport.scrollTop).toBe(0);
    expect(within(viewport).getAllByRole("listitem")).toHaveLength(3);
  });
  it("cleans observer, listener and a queued animation frame when unmounted", () => {
    const disconnect = vi.fn(),
      observe = vi.fn();
    vi.stubGlobal(
      "ResizeObserver",
      class {
        observe = observe;
        disconnect = disconnect;
      },
    );
    const request = vi
      .spyOn(window, "requestAnimationFrame")
      .mockReturnValue(321);
    const cancel = vi.spyOn(window, "cancelAnimationFrame");
    const { unmount } = render(<List />);
    const viewport = screen.getByRole("region", { name: "Test list" });
    const remove = vi.spyOn(viewport, "removeEventListener");
    fireEvent.scroll(viewport);
    fireEvent.scroll(viewport);
    expect(request).toHaveBeenCalledTimes(1);
    unmount();
    expect(disconnect).toHaveBeenCalledTimes(1);
    expect(cancel).toHaveBeenCalledWith(321);
    expect(remove).toHaveBeenCalledWith("scroll", expect.any(Function));
  });
  it("starts observing when initially empty data becomes available", () => {
    const { rerender } = render(<List rows={[]} />);
    expect(screen.queryByRole("region")).toBeNull();
    rerender(<List />);
    fireEvent.keyDown(screen.getByRole("region"), { key: "End" });
    expect(screen.getByRole("button", { name: "Record 1999" })).toHaveFocus();
  });
  it("keeps event logs unmounted until expanded and bounds them after expansion", () => {
    const { container } = render(
      <VirtualEvents
        events={items.map((item) => ({
          at: "2026-10-22T00:00:00Z",
          message: item.title,
        }))}
      />,
    );
    expect(screen.queryByRole("region", { name: "操作记录列表" })).toBeNull();
    const details = container.querySelector("details")!;
    act(() => {
      details.open = true;
      fireEvent(details, new Event("toggle"));
    });
    expect(screen.getAllByRole("listitem").length).toBeLessThanOrEqual(11);
    act(() => {
      details.open = false;
      fireEvent(details, new Event("toggle"));
    });
    expect(screen.queryByRole("region", { name: "操作记录列表" })).toBeNull();
  });
});
