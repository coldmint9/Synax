import { useState } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { QueuedInput } from "../../../../lib/api/agentRuntime";
import { runtimeMedia } from "../../../../lib/api/runtimeMedia";
import { InputQueueStrip } from "../InputQueueStrip";

vi.mock("../../../../lib/api/runtimeMedia", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../../../lib/api/runtimeMedia")>();
  return {
    ...original,
    runtimeMedia: {
      ...original.runtimeMedia,
      blob: vi.fn(),
    },
  };
});

function queuedItem(overrides: Partial<QueuedInput>): QueuedInput {
  return {
    id: "q-1",
    message: "help me with this screenshot",
    model: null,
    enqueuedAt: "2026-09-17T00:00:00.000Z",
    ...overrides,
  };
}

function queuedInputItem(): QueuedInput {
  return {
    ...queuedItem({}),
    id: "q-1",
    message: "help me with this screenshot",
    contentParts: [
      { type: "text", text: "help me with this screenshot" },
      { type: "image", assetId: "asset_a" },
      { type: "file", assetId: "asset_b" },
    ],
  };
}

function fireDrag(
  element: Element,
  type: string,
  coords: { clientY?: number } = {},
) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "clientY", { value: coords.clientY ?? 0 });
  Object.defineProperty(event, "dataTransfer", {
    value: { setData: vi.fn(), effectAllowed: "move", dropEffect: "move" },
  });
  act(() => {
    element.dispatchEvent(event);
  });
}

describe("InputQueueStrip media rendering", () => {
  it.each([
    [0, 2, "above", 1],
    [0, 2, "below", 2],
    [0, 1, "below", 1],
    [1, 2, "below", 2],
    [1, 0, "above", 0],
    [2, 0, "above", 0],
    [2, 0, "below", 1],
    [2, 1, "above", 1],
  ] as const)(
    "moves item %i at target %i %s to final index %i",
    async (from, target, side, to) => {
      const items = ["one", "two", "three"].map((id) => queuedItem({ id }));
      const onReorder = vi.fn().mockResolvedValue(undefined);
      const { container } = render(
        <InputQueueStrip
          items={items}
          onReorder={onReorder}
          onRemove={vi.fn()}
          onForce={vi.fn()}
        />,
      );
      const pills = container.querySelectorAll("li");
      const grabs = container.querySelectorAll('button[draggable="true"]');
      vi.spyOn(pills[target]!, "getBoundingClientRect").mockReturnValue({
        top: 100,
        height: 40,
      } as DOMRect);
      const coords = { clientY: side === "above" ? 110 : 130 };
      fireDrag(grabs[from]!, "dragstart");
      fireDrag(pills[target]!, "dragover", coords);
      fireDrag(pills[target]!, "drop", coords);
      expect(onReorder).toHaveBeenCalledExactlyOnceWith(items[from].id, to);
      await waitFor(() => expect(grabs[from]).not.toBeDisabled());
      // Once a drop finishes, a stray subsequent drop must not replay it.
      fireDrag(pills[target]!, "drop", coords);
      expect(onReorder).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    [0, 0, "above"],
    [0, 0, "below"],
    [0, 1, "above"],
    [1, 0, "below"],
    [1, 2, "above"],
    [2, 1, "below"],
  ] as const)(
    "does not move item %i at target %i %s when the order is unchanged",
    (from, target, side) => {
      const onReorder = vi.fn().mockResolvedValue(undefined);
      const { container } = render(
        <InputQueueStrip
          items={["one", "two", "three"].map((id) => queuedItem({ id }))}
          onReorder={onReorder}
          onRemove={vi.fn()}
          onForce={vi.fn()}
        />,
      );
      const pills = container.querySelectorAll("li");
      const grabs = container.querySelectorAll('button[draggable="true"]');
      vi.spyOn(pills[target]!, "getBoundingClientRect").mockReturnValue({
        top: 100,
        height: 40,
      } as DOMRect);
      fireDrag(grabs[from]!, "dragstart");
      fireDrag(pills[target]!, "drop", {
        clientY: side === "above" ? 110 : 130,
      });
      expect(onReorder).not.toHaveBeenCalled();
    },
  );

  it("supports keyboard reordering against the refreshed controlled queue and ignores boundaries", async () => {
    const onReorder = vi.fn();
    function ControlledQueue() {
      const [items, setItems] = useState(
        ["one", "two"].map((id) => queuedItem({ id, message: id })),
      );
      return (
        <InputQueueStrip
          items={items}
          onRemove={vi.fn()}
          onForce={vi.fn()}
          onReorder={async (id, to) => {
            onReorder(id, to);
            setItems((current) => {
              const next = [...current];
              const [moved] = next.splice(
                next.findIndex((item) => item.id === id),
                1,
              );
              next.splice(to, 0, moved);
              return next;
            });
          }}
        />
      );
    }
    const { container } = render(<ControlledQueue />);
    const handle = container.querySelectorAll(
      'button[draggable="true"]',
    )[1] as HTMLButtonElement;
    handle.focus();
    const user = userEvent.setup();
    await user.keyboard("{ArrowDown}");
    expect(onReorder).not.toHaveBeenCalled();
    await user.keyboard("{ArrowUp}");
    expect(onReorder).toHaveBeenCalledExactlyOnceWith("two", 0);
    expect(
      Array.from(
        container.querySelectorAll("li > span[title]"),
        (item) => item.textContent,
      ),
    ).toEqual(["two", "one"]);
    expect(handle).toHaveFocus();
    await user.keyboard("{ArrowUp}");
    expect(onReorder).toHaveBeenCalledTimes(1);
    await user.keyboard("{ArrowDown}");
    expect(onReorder).toHaveBeenLastCalledWith("two", 1);
    expect(onReorder).toHaveBeenCalledTimes(2);
    expect(
      Array.from(
        container.querySelectorAll("li > span[title]"),
        (item) => item.textContent,
      ),
    ).toEqual(["one", "two"]);
  });

  it("does not offer drag handles for single-item queues", () => {
    const { container } = render(
      <InputQueueStrip
        items={[queuedItem({ id: "only" })]}
        onReorder={vi.fn()}
        onRemove={vi.fn()}
        onForce={vi.fn()}
      />,
    );
    expect(container.querySelectorAll('button[draggable="true"]')).toHaveLength(
      0,
    );
  });

  it("serializes concurrent drags and lets the user retry a failed reorder", async () => {
    let reject!: (error: Error) => void;
    const onReorder = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((_resolve, fail) => {
            reject = fail;
          }),
      )
      .mockResolvedValue(undefined);
    const { container } = render(
      <InputQueueStrip
        items={[
          queuedItem({ id: "one" }),
          queuedItem({ id: "two" }),
          queuedItem({ id: "three" }),
        ]}
        onReorder={onReorder}
        onRemove={vi.fn()}
        onForce={vi.fn()}
      />,
    );
    const grabs = container.querySelectorAll('button[draggable="true"]');
    const pills = container.querySelectorAll("li");
    fireDrag(grabs[0]!, "dragstart");
    fireDrag(pills[2]!, "drop");
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(grabs[0]).toBeDisabled();
    // A second drop while the reorder is still in flight must not fire again.
    fireDrag(grabs[0]!, "dragstart");
    fireDrag(pills[2]!, "drop");
    expect(onReorder).toHaveBeenCalledTimes(1);
    await act(async () => reject(new Error("Queue changed")));
    expect(screen.getByRole("alert")).toHaveTextContent("Queue changed");
    expect(grabs[0]).not.toBeDisabled();
    fireDrag(grabs[0]!, "dragstart");
    fireDrag(pills[2]!, "drop");
    expect(onReorder).toHaveBeenCalledTimes(2);
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });
  it("renders compact image thumbnails instead of full media cards", async () => {
    vi.mocked(runtimeMedia.blob).mockResolvedValue(new Blob(["img"]));
    const { container } = render(
      <InputQueueStrip
        items={[queuedInputItem()]}
        onRemove={vi.fn()}
        onForce={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(container.querySelectorAll("img.queue-media-thumb")).toHaveLength(
        1,
      );
    });
    // Full MediaParts card markup must never appear inside the pill.
    expect(container.querySelector(".rounded-xl.border")).toBeNull();
    expect(screen.queryByText(/Loading attachment/)).toBeNull();
    expect(screen.queryByText("image.png")).toBeNull();
  });

  it("shows an overflow count beyond three image thumbnails", async () => {
    vi.mocked(runtimeMedia.blob).mockResolvedValue(new Blob(["img"]));
    const { container } = render(
      <InputQueueStrip
        items={[
          queuedItem({
            id: "q-many",
            contentParts: [
              { type: "image", assetId: "asset_1" },
              { type: "image", assetId: "asset_2" },
              { type: "image", assetId: "asset_3" },
              { type: "image", assetId: "asset_4" },
              { type: "image", assetId: "asset_5" },
            ],
          }),
        ]}
        onRemove={vi.fn()}
        onForce={vi.fn()}
      />,
    );
    await waitFor(() => {
      expect(container.querySelectorAll("img.queue-media-thumb")).toHaveLength(
        3,
      );
    });
    expect(screen.getByText("+2")).toBeDefined();
  });

  it("summarizes non-image attachments as a paperclip count chip", () => {
    vi.mocked(runtimeMedia.blob).mockResolvedValue(new Blob(["img"]));
    render(
      <InputQueueStrip
        items={[
          queuedItem({
            id: "q-files",
            contentParts: [
              { type: "image", assetId: "asset_1" },
              { type: "file", assetId: "asset_2" },
              { type: "video", assetId: "asset_3" },
            ],
          }),
        ]}
        onRemove={vi.fn()}
        onForce={vi.fn()}
      />,
    );
    expect(screen.getByText("2")).toBeDefined();
  });

  it("keeps queue items without media unchanged", () => {
    const { container } = render(
      <InputQueueStrip
        items={[queuedItem({ contentParts: undefined })]}
        onRemove={vi.fn()}
        onForce={vi.fn()}
      />,
    );
    expect(container.querySelector("img")).toBeNull();
    expect(screen.getByText(/help me with this screenshot/)).toBeDefined();
  });
});
