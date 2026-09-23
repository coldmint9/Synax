import { useState } from "react";
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, expect, it, vi } from "vitest";
import { InputOptimizationSettings } from "./InputOptimizationSettings";
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

it("always offers current-model fallback and excludes ACP models", () => {
  render(<InputOptimizationSettings config={config} onUpdate={vi.fn()} />);
  expect(screen.getByRole("combobox", { name: "输入优化模型" })).toHaveValue(
    "default",
  );
  expect(
    screen.getByRole("option", { name: "跟随当前选择的模型" }),
  ).toBeInTheDocument();
  expect(
    screen.queryByRole("option", { name: /Codex/ }),
  ).not.toBeInTheDocument();
});

it("saves an optimization-specific model and allows restoring the default", async () => {
  const save = vi.fn();
  function Settings() {
    const [value, setValue] = useState(config);
    return (
      <InputOptimizationSettings
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
  expect(save).toHaveBeenCalledWith({
    inputOptimizationModel: "openai/wiki-test-model",
  });
  expect(input).toHaveValue("openai/wiki-test-model");
  await userEvent.selectOptions(input, "default");
  expect(save).toHaveBeenLastCalledWith({ inputOptimizationModel: "" });
});

it("retains the saved model and shows an error when saving fails", async () => {
  render(
    <InputOptimizationSettings
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

it("retains unavailable selections rather than silently showing default", () => {
  render(
    <InputOptimizationSettings
      config={{ ...config, inputOptimizationModel: "removed/model" }}
      onUpdate={vi.fn()}
    />,
  );
  expect(screen.getByRole("combobox")).toHaveValue("removed/model");
  expect(
    screen.getByRole("option", { name: /removed\/model.*当前不可用/ }),
  ).toBeInTheDocument();
});
