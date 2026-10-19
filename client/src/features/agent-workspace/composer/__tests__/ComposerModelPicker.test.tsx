import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useShellStore } from "../../../../shared/state/shellStore";
import type {
  GlobalConfig,
  ProviderDef,
} from "../../../../shared/contracts/config";
import { ComposerModelPicker } from "../ComposerModelPicker";

const globalConfig: GlobalConfig = {
  version: 1,
  providers: [],
  defaultProviderId: "openai",
  defaultApiProviderId: "openai",
  enabledAcpProviderIds: [],
  providerConnections: {
    "custom-api:gateway": { providerId: "custom-api:gateway", apiKeyMasked: "***", extra: { kind: "api", apiFormat: "openai", model: "gateway-default" } },
    openai: {
      providerId: "openai",
      apiKeyMasked: "sk-***",
      extra: { model: "gpt-5" },
    },
  },
  mcpServers: [],
  webSearch: { routing: "disabled", remote: { externalWebAccess: false, searchContextSize: "medium" }, local: { engine: "duckduckgo", auth: { type: "none" } } },
  limits: { maxAgentsPerProject: 1, agentTimeoutMs: 1 },
  features: { allowProjectConnectionOverride: true },
  updatedAt: "2026-01-01T00:00:00.000Z",
  updatedBy: "test",
};

const providers: ProviderDef[] = [
  {
    id: "openai",
    label: "OpenAI",
    status: "live",
    kind: "api",
    caps: { canFollowUp: true, canCancel: true },
    models: [{ id: "gpt-5", label: "gpt-5", isDefault: true }],
  },
  {
    id: "custom-api:gateway",
    label: "Gateway",
    status: "live",
    kind: "api",
    caps: { canFollowUp: true, canCancel: true },
    models: [
      { id: "gateway-default", label: "Gateway Default", isDefault: true },
    ],
  },
];

async function openPicker(onSelect = vi.fn()) {
  render(
    <ComposerModelPicker
      globalConfig={globalConfig}
      providers={providers}
      providerId="openai"
      modelId="gpt-5"
      onSelect={onSelect}
    />,
  );
  await userEvent.click(screen.getByRole("button", { name: "选择模型" }));
  return onSelect;
}

describe("ComposerModelPicker", () => {
  beforeEach(() => {
    useShellStore.setState((state) => ({
      preferences: { ...state.preferences, locale: "zh" },
    }));
  });

  it("shows only the model name in the trigger while the tooltip keeps the full context", () => {
    render(
      <ComposerModelPicker
        globalConfig={globalConfig}
        providers={providers}
        providerId="openai"
        modelId="gpt-5"
        onSelect={vi.fn()}
      />,
    );

    const trigger = screen.getByRole("button", { name: "选择模型" });
    expect(trigger).toHaveTextContent("gpt-5");
    expect(trigger).not.toHaveTextContent("OpenAI");
    expect(trigger).not.toHaveTextContent("对话");
    expect(trigger).toHaveAttribute("title", "OpenAI · gpt-5 · 对话");
  });

  it("groups models by provider name without provider ID suffixes", async () => {
    await openPicker();

    const listbox = screen.getByRole("listbox", { name: "选择模型" });
    const options = within(listbox).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "gpt-5对话",
      "Gateway Default对话",
    ]);

    expect(within(listbox).getAllByRole("group")).toHaveLength(2);
    expect(
      within(listbox).getByRole("group", { name: "OpenAI" }),
    ).toContainElement(options[0]);
    expect(
      within(listbox).getByRole("group", { name: "Gateway" }),
    ).toContainElement(options[1]);
    expect(screen.queryByText("API 模型")).toBeNull();
    expect(screen.queryByText("ACP 端点")).toBeNull();
  });

  it("keeps the portaled panel inside the dock outside-dismiss boundary", async () => {
    const user = userEvent.setup();
    await openPicker();

    let dismissed = false;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (!target.closest('[role="menu"], [role="listbox"], [data-slot="popover"]')) {
        dismissed = true;
      }
    };
    document.addEventListener("pointerdown", onPointerDown, true);

    try {
      const panel = screen.getByRole("combobox").closest('[data-slot="popover"]');
      expect(panel).toBeInTheDocument();
      expect(panel).toHaveClass("pointer-events-auto", "z-[1300]");

      await user.click(screen.getByRole("combobox"));
      expect(dismissed).toBe(false);
    } finally {
      document.removeEventListener("pointerdown", onPointerDown, true);
    }
  });

  it("marks the current selection and reports the picked option", async () => {
    const onSelect = await openPicker();

    const listbox = screen.getByRole("listbox", { name: "选择模型" });
    const [apiOption, gatewayOption] = within(listbox).getAllByRole("option");
    expect(apiOption).toHaveAttribute("aria-selected", "true");
    expect(gatewayOption).toHaveAttribute("aria-selected", "false");

    await userEvent.click(gatewayOption);
    expect(onSelect).toHaveBeenCalledWith({
      kind: "api",
      providerId: "custom-api:gateway",
      modelId: "gateway-default",
      label: "Gateway Default",
      capability: "chat",
    });
  });
});

it("searches models and provider groups with real Combobox keyboard selection and observes only actual open state", async () => {
  const user = userEvent.setup(), selected = vi.fn(), overlay = vi.fn();
  const large = [
    { ...providers[0], models: Array.from({ length: 45 }, (_, i) => ({ id: `model-${i}`, label: `Model ${i}` })) },
    providers[1],
  ];
  const { container } = render(<ComposerModelPicker globalConfig={globalConfig} providers={large} providerId="openai" modelId="model-0" onSelect={selected} onOverlayOpenChange={overlay} />);
  const trigger = screen.getByRole("button", { name: "选择模型" });
  await user.click(trigger);
  const search = screen.getByRole("combobox");
  expect(search).toHaveFocus();
  expect(container).not.toContainElement(search);
  await user.type(search, "missing");
  expect(screen.queryByRole("option")).not.toBeInTheDocument();
  await user.clear(search);
  await user.type(search, "gateway");
  expect(screen.getAllByRole("group")).toHaveLength(1);
  const option = screen.getByRole("option", { name: /Gateway Default/ });
  await user.keyboard("{ArrowDown}");
  await waitFor(() => expect(search).toHaveAttribute("aria-activedescendant", option.id));
  await user.keyboard("{Enter}");
  expect(selected).toHaveBeenCalledWith(expect.objectContaining({ providerId: "custom-api:gateway", modelId: "gateway-default" }));
  expect(trigger).toHaveFocus();
  expect(overlay.mock.calls).toEqual([[false], [true], [false]]);
  await user.click(trigger);
  expect(screen.getByRole("combobox")).toHaveValue("");
  expect(screen.getAllByRole("option").length).toBeGreaterThan(40);
  await user.keyboard("{Escape}");
  await waitFor(() => expect(screen.queryByRole("combobox")).not.toBeInTheDocument());
  expect(trigger).toHaveFocus();
});

it("filters backend choices, closes on disable, and reports teardown without creating a second open state", async () => {
  const user = userEvent.setup(), select = vi.fn(), overlay = vi.fn();
  const props = { globalConfig, providers, providerId: "openai", modelId: "gpt-5", onSelect: select, onOverlayOpenChange: overlay, backendId: "native" };
  const view = render(<ComposerModelPicker {...props} />);
  await user.click(screen.getByRole("button", { name: "选择模型" }));
  expect(screen.getAllByRole("group")).toHaveLength(2);
  expect(screen.getByRole("group", { name: "OpenAI" })).toBeVisible();
  view.rerender(<ComposerModelPicker {...props} disabled />);
  await waitFor(() => expect(screen.queryByRole("listbox")).not.toBeInTheDocument());
  expect(screen.getByRole("button", { name: "选择模型" })).toBeDisabled();
  expect(select).not.toHaveBeenCalled();
  expect(overlay).toHaveBeenLastCalledWith(false);
});

it("never exposes removed ACP models even when an old provider remains in saved settings", async () => {
  const retired = { ...providers[1], id: "cursor-acp", label: "Retired", kind: "acp" as const };
  render(<ComposerModelPicker globalConfig={globalConfig} providers={[...providers, retired]} providerId="openai" modelId="gpt-5" onSelect={vi.fn()} />);
  await userEvent.click(screen.getByRole("button", { name: "选择模型" }));
  expect(screen.queryByRole("group", { name: "Retired" })).not.toBeInTheDocument();
  expect(screen.getAllByRole("option")).toHaveLength(2);
});
