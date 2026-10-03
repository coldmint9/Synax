import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect, it, vi } from "vitest";
import { ProjectImportHint } from "../ProjectImportHint";

it("dismisses immediately when Import is clicked, even if no project is created", async () => {
  const onImport = vi.fn();
  const view = render(
    <ProjectImportHint hasProject={false} onImport={onImport} />,
  );
  expect(view.container.querySelector("svg path")).not.toBeNull();
  await userEvent.click(
    screen.getByRole("button", { name: "导入项目", exact: true }),
  );
  expect(onImport).toHaveBeenCalledOnce();
  expect(screen.queryByLabelText("导入项目引导")).toBeNull();
  // Cancelling import or remounting the page must not bring the guide back.
  view.unmount();
  render(<ProjectImportHint hasProject={false} onImport={onImport} />);
  expect(screen.queryByLabelText("导入项目引导")).toBeNull();
});

it("dismisses after opening its project-switcher target and remembers that interaction", () => {
  const onImport = vi.fn();
  const view = render(
    <ProjectImportHint hasProject={false} onImport={onImport} />,
  );
  view.rerender(
    <ProjectImportHint
      hasProject={false}
      onImport={onImport}
      targetActivated
    />,
  );
  expect(screen.queryByLabelText("导入项目引导")).toBeNull();
  view.rerender(
    <ProjectImportHint
      hasProject={false}
      onImport={onImport}
      targetActivated={false}
    />,
  );
  expect(screen.queryByLabelText("导入项目引导")).toBeNull();
  view.unmount();
  render(<ProjectImportHint hasProject={false} onImport={onImport} />);
  expect(screen.queryByLabelText("导入项目引导")).toBeNull();
  expect(onImport).not.toHaveBeenCalled();
});

it("still supports explicit dismissal without opening import", async () => {
  const onImport = vi.fn();
  render(<ProjectImportHint hasProject={false} onImport={onImport} />);
  await userEvent.click(screen.getByRole("button", { name: "关闭导入提示" }));
  expect(screen.queryByLabelText("导入项目引导")).toBeNull();
  expect(onImport).not.toHaveBeenCalled();
});

it("does not reappear after a project has been selected", () => {
  const view = render(
    <ProjectImportHint hasProject={true} onImport={vi.fn()} />,
  );
  view.rerender(<ProjectImportHint hasProject={false} onImport={vi.fn()} />);
  expect(screen.queryByLabelText("导入项目引导")).toBeNull();
});
