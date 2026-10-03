import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { SessionTodoPanel } from "../SessionTodoPanel";

afterEach(cleanup);

describe("SessionTodoPanel", () => {
  it("keeps the task list and completion count without a progress bar", () => {
    render(
      <SessionTodoPanel
        items={[
          { id: "done", label: "Completed task", status: "done" },
          { id: "pending", label: "Pending task", status: "pending" },
        ]}
      />,
    );
    expect(screen.getByText("1 / 2")).toBeTruthy();
    expect(screen.getAllByRole("listitem")).toHaveLength(2);
    expect(screen.getByText("Completed task")).toBeTruthy();
    expect(screen.getByText("Pending task")).toBeTruthy();
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  it("renders nothing when there are no tasks", () => {
    const { container } = render(<SessionTodoPanel items={[]} />);
    expect(container.firstChild).toBeNull();
  });
});
