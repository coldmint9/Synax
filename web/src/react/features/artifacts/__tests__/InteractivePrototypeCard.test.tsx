import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { InteractivePrototypeCard } from "../InteractivePrototypeCard";
import { mountPreview } from "../transport";

vi.mock("../transport", () => ({
  desktopEnvironment: () => ({ desktop: false }),
  mountPreview: vi.fn(),
}));

const prototype = {
  id: "message-1:abc",
  title: "水平导航栏 Demo",
  sourceKind: "react" as const,
  html: "<html><body><button>Continue</button></body></html>",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("IntersectionObserver", undefined);
  vi.spyOn(document, "hidden", "get").mockReturnValue(false);
  vi.mocked(mountPreview).mockImplementation((options) => {
    options.onConnected();
    return { send: vi.fn(), destroy: vi.fn(), update: vi.fn() };
  });
});

describe("InteractivePrototypeCard", () => {
  it("mounts the prototype directly without product management chrome", async () => {
    render(<InteractivePrototypeCard prototype={prototype} />);
    await waitFor(() => expect(mountPreview).toHaveBeenCalledTimes(1));
    expect(screen.getByLabelText(prototype.title)).toBeVisible();
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
    expect(screen.queryByRole("tablist")).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
    expect(screen.getByText(prototype.title)).toBeInTheDocument();
  });
});

it("keeps only two live instances for three cards without remount thrashing; a parked card resumes on focus", async () => {
  const destroy = vi.fn();
  vi.mocked(mountPreview).mockImplementation((options) => {
    options.onConnected();
    return { send: vi.fn(), destroy, update: vi.fn() };
  });
  const { container } = render(
    <>
      {[1, 2, 3].map((n) => (
        <InteractivePrototypeCard
          key={n}
          prototype={{ ...prototype, id: `m:${n}`, title: `Demo ${n}` }}
        />
      ))}
    </>,
  );
  await waitFor(() => expect(mountPreview).toHaveBeenCalledTimes(3));
  expect(container.querySelectorAll('[data-live="true"]')).toHaveLength(2);
  expect(destroy).toHaveBeenCalledTimes(1);
  screen.getByLabelText("Demo 1").focus();
  await waitFor(() => expect(mountPreview).toHaveBeenCalledTimes(4));
  expect(container.querySelectorAll('[data-live="true"]')).toHaveLength(2);
});

it("ignores deleted state/feedback methods and accepts only ready/theme and bounded resize", async () => {
  render(<InteractivePrototypeCard prototype={prototype} />);
  await waitFor(() => expect(mountPreview).toHaveBeenCalledTimes(1));
  const options = vi.mocked(mountPreview).mock.calls[0][0];
  expect(options.onRequest("ready", {})).toMatchObject({ theme: "light" });
  for (const type of [
    "state",
    "feedbackDraft",
    "controls",
    "element",
    "capture",
  ])
    expect(() => options.onRequest(type, {})).toThrow();
});

it("destroys a mounted preview when removed", async () => {
  const destroy = vi.fn();
  vi.mocked(mountPreview).mockImplementation((options) => {
    options.onConnected();
    return { send: vi.fn(), destroy, update: vi.fn() };
  });
  const view = render(<InteractivePrototypeCard prototype={prototype} />);
  await waitFor(() => expect(mountPreview).toHaveBeenCalledTimes(1));
  view.unmount();
  expect(destroy).toHaveBeenCalledOnce();
});
