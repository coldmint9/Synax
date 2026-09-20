import { useState } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { WikiModelSettings } from "./WikiModelSettings";
import { useShellStore } from "../../../state/shellStore";
import type { GlobalConfig } from "../../../../lib/contracts/config";

vi.mock("./SettingsSelect", () => ({
  SettingsSelect: ({
    selectedKey,
    onSelectionChange,
    options,
    isDisabled,
    "aria-label": label,
  }: any) => (
    <select
      aria-label={label}
      value={selectedKey}
      disabled={isDisabled}
      onChange={(event) => onSelectionChange(event.target.value)}
    >
      {options.map((option: any) => (
        <option key={option.key} value={option.key}>
          {option.label}
        </option>
      ))}
    </select>
  ),
}));
const config = {
  providers: [
    {
      id: "openai",
      label: "OpenAI",
      kind: "api",
      status: "live",
      models: [
        { id: "wiki-test-model", label: "Wiki test model", isDefault: true },
      ],
    },
    {
      id: "codex-acp",
      label: "Codex",
      kind: "acp",
      status: "live",
      models: [{ id: "default" }],
    },
  ],
  providerConnections: {
    openai: {
      providerId: "openai",
      apiKeyMasked: "sk-test",
      extra: { model: "wiki-test-model" },
    },
  },
} as unknown as GlobalConfig;
beforeEach(() => {
  useShellStore.getState().setWikiEnabled(false);
});

it("shows the warning and model selection only when the Wiki menu is enabled", () => {
  render(<WikiModelSettings config={config} onUpdate={vi.fn()} />);
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
  expect(screen.queryByRole("note")).not.toBeInTheDocument();
  act(() => useShellStore.getState().setWikiEnabled(true));
  expect(
    screen.getByRole("combobox", { name: "Wiki 工作流模型" }),
  ).toBeVisible();
  expect(screen.getByRole("note")).toHaveTextContent(
    "⚠️ 该功能会消耗大量 token，谨慎使用，后续可能会重构。",
  );
  expect(
    screen.queryByRole("option", { name: /Codex/ }),
  ).not.toBeInTheDocument();
  act(() => useShellStore.getState().setWikiEnabled(false));
  expect(screen.queryByRole("combobox")).not.toBeInTheDocument();
});

it("saves a Wiki-specific model and allows restoring the default", async () => {
  act(() => useShellStore.getState().setWikiEnabled(true));
  const save = vi.fn();
  function Settings() {
    const [value, setValue] = useState(config);
    return (
      <WikiModelSettings
        config={value}
        onUpdate={async (patch) => {
          save(patch);
          setValue({ ...value, ...patch });
        }}
      />
    );
  }
  render(<Settings />);
  const input = screen.getByRole("combobox");
  await userEvent.selectOptions(input, "openai/wiki-test-model");
  expect(save).toHaveBeenCalledWith({ wikiModel: "openai/wiki-test-model" });
  expect(input).toHaveValue("openai/wiki-test-model");
  await userEvent.selectOptions(input, "default");
  expect(save).toHaveBeenLastCalledWith({ wikiModel: "" });
});

it("retains the saved model and shows an error when saving fails", async () => {
  act(() => useShellStore.getState().setWikiEnabled(true));
  render(
    <WikiModelSettings
      config={config}
      onUpdate={async () => {
        throw new Error("Save failed");
      }}
    />,
  );
  await userEvent.selectOptions(
    screen.getByRole("combobox"),
    "openai/wiki-test-model",
  );
  expect(await screen.findByRole("alert")).toHaveTextContent("Save failed");
  await waitFor(() =>
    expect(screen.getByRole("combobox")).toHaveValue("default"),
  );
});
