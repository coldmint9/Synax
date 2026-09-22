import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { LayoutSection } from "../LayoutSection";
import { configApi } from "../../../../../lib/api/config";
import { useShellStore } from "../../../../state/shellStore";

vi.mock("../../../../../lib/api/config", () => ({ configApi: { listFileOpeners: vi.fn() } }));
const icon = "data:image/png;base64,iVBORw0KGgo=";
beforeEach(() => {
  vi.resetAllMocks();
  useShellStore.setState((s) => ({ preferences: { ...s.preferences, editor: "system", locale: "zh" } }));
});

it("loads detected apps in the actual settings section and renders icons in options and selected value", async () => {
  vi.mocked(configApi.listFileOpeners).mockResolvedValue({ apps: [
    { id: "system", name: "System default", icon },
    { id: "zed", name: "Zed", icon },
    { id: "finder", name: "Finder", icon },
  ] });
  render(<LayoutSection />);
  const user = userEvent.setup();
  await waitFor(() => expect(configApi.listFileOpeners).toHaveBeenCalledOnce());
  const trigger = screen.getByRole("button", { name: /默认文件打开位置/ });
  await waitFor(() => expect(trigger).not.toBeDisabled());
  expect(trigger.querySelector("img")).toHaveAttribute("src", icon);
  await user.click(trigger);
  const option = await screen.findByRole("option", { name: "Zed" });
  expect(option.querySelector("img")).toHaveAttribute("src", icon);
  expect(screen.getByRole("option", { name: "Finder" })).toBeTruthy();
  for (const name of ["Cursor", "Windsurf", "WebStorm"]) {
    expect(screen.queryByRole("option", { name })).toBeNull();
  }
  await user.click(option);
  expect(useShellStore.getState().preferences.editor).toBe("zed");
  expect(trigger).toHaveTextContent("Zed");
  expect(trigger.querySelector("img")).toHaveAttribute("src", icon);
});

it("shows discovery failure in the settings section rather than advertising hardcoded apps", async () => {
  vi.mocked(configApi.listFileOpeners).mockRejectedValue(new Error("Unavailable"));
  render(<LayoutSection />);
  expect(await screen.findByRole("button", { name: /检测失败/ })).toBeTruthy();
  await userEvent.setup().click(screen.getByRole("button", { name: /默认文件打开位置/ }));
  expect(screen.queryByRole("option", { name: "VS Code" })).toBeNull();
});
