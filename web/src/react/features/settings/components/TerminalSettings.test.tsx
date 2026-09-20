import { useState } from "react";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { TerminalSettings } from "./TerminalSettings";
import { configApi } from "../../../../lib/api/config";
vi.mock("../../../../lib/api/config", () => ({
  configApi: { getTerminalShell: vi.fn() },
}));
beforeEach(() => {
  vi.mocked(configApi.getTerminalShell).mockResolvedValue({
    defaultPath: "/bin/zsh",
  });
});
it("displays the system path, saves an override and restores the default", async () => {
  const onUpdate = vi.fn();
  function Settings() {
    const [path, setPath] = useState("");
    return (
      <TerminalSettings
        configuredPath={path}
        onUpdate={async (patch) => {
          onUpdate(patch);
          setPath(patch.terminalShellPath!);
        }}
      />
    );
  }
  render(<Settings />);
  expect(await screen.findByText("/bin/zsh")).toBeVisible();
  const input = screen.getByRole("textbox", { name: "Shell 可执行文件路径" });
  await userEvent.type(input, "/opt/custom shell");
  expect(screen.getByText("系统默认")).toBeVisible();
  await userEvent.click(
    screen.getByRole("button", { name: "保存终端路径", exact: true }),
  );
  expect(onUpdate).toHaveBeenCalledWith({
    terminalShellPath: "/opt/custom shell",
  });
  expect(screen.getByText("当前生效路径：").textContent).toBe(
    "当前生效路径：/opt/custom shell",
  );
  await userEvent.click(screen.getByRole("button", { name: "恢复系统默认" }));
  expect(onUpdate).toHaveBeenLastCalledWith({ terminalShellPath: "" });
  expect(await screen.findByText("/bin/zsh")).toBeVisible();
  expect(input).toHaveValue("");
});
it("retains the saved path and draft when validation fails", async () => {
  render(
    <TerminalSettings
      configuredPath="/bin/zsh"
      onUpdate={async () => {
        throw new Error("Invalid shell path");
      }}
    />,
  );
  const input = screen.getByRole("textbox", { name: "Shell 可执行文件路径" });
  await userEvent.clear(input);
  await userEvent.type(input, "/missing");
  await userEvent.click(
    screen.getByRole("button", { name: "保存终端路径", exact: true }),
  );
  expect(await screen.findByRole("alert")).toHaveTextContent(
    "Invalid shell path",
  );
  expect(input).toHaveValue("/missing");
  expect(screen.getByText("当前生效路径：")).toHaveTextContent(
    "当前生效路径：/bin/zsh",
  );
});
