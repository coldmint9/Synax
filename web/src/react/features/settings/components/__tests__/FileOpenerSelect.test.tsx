import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { FileOpenerSelect } from "../FileOpenerSelect";
import { configApi } from "../../../../../lib/api/config";
import { useShellStore } from "../../../../state/shellStore";
vi.mock("../../../../../lib/api/config", () => ({
  configApi: { listFileOpeners: vi.fn() },
}));
vi.mock("../SettingsSelect", () => ({
  SettingsSelect: ({
    selectedKey,
    onSelectionChange,
    options,
    isDisabled,
    ...props
  }: any) => (
    <select
      aria-label={props["aria-label"]}
      value={selectedKey}
      disabled={isDisabled}
      onChange={(e) => onSelectionChange(e.target.value)}
    >
      {options.map((option: any) => (
        <option
          key={option.key}
          value={option.key}
          disabled={option.isDisabled}
        >
          {option.textValue}
        </option>
      ))}
    </select>
  ),
}));
beforeEach(() => {
  vi.resetAllMocks();
  useShellStore.setState((s) => ({
    preferences: { ...s.preferences, editor: "system", locale: "zh" },
  }));
});
describe("FileOpenerSelect", () => {
  it("lists only detected apps and persists a selection", async () => {
    vi.mocked(configApi.listFileOpeners).mockResolvedValue({
      apps: [
        { id: "system", name: "System default", icon: null },
        { id: "zed", name: "Zed", icon: null },
      ],
    });
    render(<FileOpenerSelect />);
    await screen.findByRole("option", { name: "Zed" });
    expect(screen.queryByRole("option", { name: "Cursor" })).toBeNull();
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "zed" },
    });
    expect(useShellStore.getState().preferences.editor).toBe("zed");
  });
  it("reports an unavailable saved application without silently changing the preference", async () => {
    useShellStore.setState((s) => ({
      preferences: { ...s.preferences, editor: "cursor" },
    }));
    vi.mocked(configApi.listFileOpeners).mockResolvedValue({
      apps: [{ id: "system", name: "System default", icon: null }],
    });
    render(<FileOpenerSelect />);
    await screen.findByText(/所选应用不可用/);
    expect(useShellStore.getState().preferences.editor).toBe("cursor");
  });
  it("offers retry after discovery fails", async () => {
    vi.mocked(configApi.listFileOpeners)
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce({
        apps: [{ id: "system", name: "System default", icon: null }],
      });
    render(<FileOpenerSelect />);
    fireEvent.click(await screen.findByRole("button", { name: /重试/ }));
    await waitFor(() =>
      expect(configApi.listFileOpeners).toHaveBeenCalledTimes(2),
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: /重试/ })).toBeNull(),
    );
  });
});
