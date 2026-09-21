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
  it("reorders queued inputs by dragging a pill onto another position", async () => {
    const onReorder = vi.fn().mockResolvedValue(undefined);
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
    const pills = container.querySelectorAll("li");
    const grabs = container.querySelectorAll('button[draggable="true"]');
    expect(grabs).toHaveLength(3);
    // jsdom rects collapse to zero, so every drop lands "above" the target.
    fireDrag(grabs[0]!, "dragstart");
    fireDrag(pills[2]!, "dragover");
    fireDrag(pills[2]!, "drop");
    expect(onReorder).toHaveBeenCalledTimes(1);
    expect(onReorder).toHaveBeenCalledWith("one", 1);
    await waitFor(() => expect(grabs[0]).toBeEnabled());
    fireDrag(grabs[2]!, "dragstart");
    fireDrag(pills[0]!, "dragover");
    fireDrag(pills[0]!, "drop");
    expect(onReorder).toHaveBeenLastCalledWith("three", 0);
    await waitFor(() => expect(grabs[2]).toBeEnabled());
    // Dropping right after itself is a no-op and must not call the API.
    fireDrag(grabs[0]!, "dragstart");
    fireDrag(pills[1]!, "dragover");
    fireDrag(pills[1]!, "drop");
    expect(onReorder).toHaveBeenCalledTimes(2);
    // A stray drop without an active drag is ignored.
    fireDrag(pills[2]!, "drop");
    expect(onReorder).toHaveBeenCalledTimes(2);
  });

  it("supports keyboard reordering through the focused drag handle", async () => {
    const onReorder = vi.fn().mockResolvedValue(undefined);
    const props = { onReorder, onRemove: vi.fn(), onForce: vi.fn() };
    const one = queuedItem({ id: "one" }),
      two = queuedItem({ id: "two" });
    const { container, rerender } = render(
      <InputQueueStrip {...props} items={[one, two]} />,
    );
    const handle = container.querySelectorAll('button[draggable="true"]')[1]!;
    (handle as HTMLElement).focus();
    await userEvent.keyboard("{ArrowUp}");
    expect(onReorder).toHaveBeenCalledExactlyOnceWith("two", 0);
    await waitFor(() => expect(handle).toBeEnabled());
    // This is a controlled queue: acknowledge the backend's reordered items.
    rerender(<InputQueueStrip {...props} items={[two, one]} />);
    (handle as HTMLElement).focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(onReorder).toHaveBeenLastCalledWith("two", 1);
    await waitFor(() => expect(handle).toBeEnabled());
  });

  it.each([
    [0, 2, 0, "one", 1],
    [0, 2, 1, "one", 2],
    [2, 0, 0, "three", 0],
    [2, 0, 1, "three", 1],
  ] as const)(
    "maps drop gaps to final backend indices (%s -> %s, y=%s)",
    async (from, target, clientY, id, to) => {
      const onReorder = vi.fn().mockResolvedValue(undefined);
      const { container } = render(
        <InputQueueStrip
          items={["one", "two", "three"].map((id) => queuedItem({ id }))}
          onReorder={onReorder}
          onRemove={vi.fn()}
          onForce={vi.fn()}
        />,
      );
      const handles = container.querySelectorAll('button[draggable="true"]');
      fireDrag(handles[from]!, "dragstart");
      fireDrag(container.querySelectorAll("li")[target]!, "drop", { clientY });
      expect(onReorder).toHaveBeenCalledExactlyOnceWith(id, to);
      await waitFor(() => expect(handles[from]).toBeEnabled());
    },
  );

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
