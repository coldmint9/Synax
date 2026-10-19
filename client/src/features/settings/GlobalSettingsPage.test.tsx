import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GlobalConfig, ProviderDef } from "../../shared/contracts/config";
import { useState, type ReactNode } from "react";

// Appearance has its own integration tests using real Synax UI color controls.
vi.mock("./components/AppearanceSection", () => ({
  AppearanceSection: () => <div />,
}));



const mocks = vi.hoisted(() => ({
  discoverAiModels: vi.fn(),
  validateAiApi: vi.fn(),
  reload: vi.fn(),
  updateGlobalConfig: vi.fn(),
  state: {
    loading: false,
    globalConfig: null as GlobalConfig | null,
    providers: [] as ProviderDef[],
  },
}));

const acpProviders: ProviderDef[] = [
  {
    id: "opencode-acp",
    label: "OpenCode ACP",
    status: "live",
    kind: "acp",
    caps: { canFollowUp: true, canCancel: true },
    models: [
      { id: "opencode-default", label: "OpenCode Default", isDefault: true },
    ],
  },
  {
    id: "cursor-acp",
    label: "Cursor ACP",
    status: "live",
    kind: "acp",
    caps: { canFollowUp: true, canCancel: true },
    models: [
      { id: "cursor-default", label: "Cursor Default", isDefault: true },
    ],
  },
];

function createGlobalConfig(extra?: Partial<GlobalConfig>): GlobalConfig {
  const providers: ProviderDef[] = [
    ...acpProviders,
    {
      id: "openai",
      label: "OpenAI",
      description: "OpenAI API",
      status: "live",
      kind: "api",
      caps: { canFollowUp: true, canCancel: true },
      models: [{ id: "gpt-4o-mini", label: "gpt-4o-mini", isDefault: true }],
    },
    {
      id: "anthropic",
      label: "Anthropic",
      description: "Anthropic Messages API",
      status: "live",
      kind: "api",
      caps: { canFollowUp: true, canCancel: true },
      models: [
        {
          id: "claude-3-5-sonnet-latest",
          label: "claude-3-5-sonnet-latest",
          isDefault: true,
        },
      ],
    },
    ...(extra?.providers?.filter(
      (p) =>
        !["opencode-acp", "cursor-acp", "openai", "anthropic"].includes(p.id),
    ) ?? []),
  ];

  const base: GlobalConfig = {
    version: 1,
    providers,
    defaultProviderId: "opencode-acp",
    defaultApiProviderId: "openai",
    enabledAcpProviderIds: ["opencode-acp"],
    providerConnections: {
      "opencode-acp": {
        providerId: "opencode-acp",
        baseUrl: "http://127.0.0.1:3210",
        extra: { kind: "acp" },
      },
      "cursor-acp": {
        providerId: "cursor-acp",
        baseUrl: "http://127.0.0.1:3210",
        extra: { kind: "acp" },
      },
      openai: {
        providerId: "openai",
        baseUrl: "https://api.openai.com/v1",
        apiKeyMasked: "sk-o****1234",
        extra: { kind: "api", apiFormat: "openai", model: "gpt-4o-mini" },
      },
      anthropic: {
        providerId: "anthropic",
        baseUrl: "https://api.anthropic.com/v1",
        extra: {
          kind: "api",
          apiFormat: "anthropic",
          model: "claude-3-5-sonnet-latest",
        },
      },
      ...(extra?.providerConnections ?? {}),
    },
    limits: { maxAgentsPerProject: 10, agentTimeoutMs: 300000 },
    features: { allowProjectConnectionOverride: true },
    updatedAt: "2026-05-13T00:00:00.000Z",
    updatedBy: "test",
  };

  return {
    ...base,
    ...extra,
    providers,
    providerConnections: {
      ...base.providerConnections,
      ...(extra?.providerConnections ?? {}),
    },
    limits: { ...base.limits, ...(extra?.limits ?? {}) },
    features: { ...base.features, ...(extra?.features ?? {}) },
  };
}

// These tests exercise configuration and persistence, not per-keystroke logic.
// Paste is a real user input event and avoids re-rendering the full settings
// page for every character while the full suite runs in parallel.
async function pasteValue(
  user: ReturnType<typeof userEvent.setup>,
  field: HTMLElement,
  value: string,
) {
  await user.click(field);
  await user.paste(value);
}

// Providers now live in their own pinned settings menu entry.
async function renderPage(section: "general" | "llmProviders" = "llmProviders") {
  const { default: GlobalSettingsPage } =
    await import("./GlobalSettingsPage.tsx");
  return render(
    <MemoryRouter initialEntries={[`/settings?section=${section}`]}>
      <GlobalSettingsPage />
    </MemoryRouter>,
  );
}

async function openConnectedProvider(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole("button", { name: /添加/ }));
  await user.type(screen.getByRole("textbox", { name: "服务地址" }), "https://llm.internal/v1");
  await user.type(screen.getByLabelText("API Key", { exact: true }), "sk-local");
  await user.click(screen.getByRole("button", { name: "连接并获取模型" }));
  await screen.findByRole("checkbox", { name: "deepseek-chat", exact: true });
}

describe("GlobalSettingsPage LLM provider redesign", () => {
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  beforeEach(async () => {
    vi.restoreAllMocks();
    vi.resetAllMocks();

    mocks.discoverAiModels.mockResolvedValue({
      ok: true,
      models: ["deepseek-chat", "deepseek-reasoner"],
      source: "api/models",
    });
    mocks.validateAiApi.mockResolvedValue({ ok: true, message: "ok" });
    mocks.reload.mockResolvedValue(undefined);
    mocks.updateGlobalConfig.mockResolvedValue(undefined);
    mocks.state.globalConfig = createGlobalConfig();
    mocks.state.loading = false;
    mocks.state.providers = mocks.state.globalConfig.providers;

    const configModule = await import("../../adapters/transport/config.ts");
    vi.spyOn(configModule.configApi, "getTerminalShell").mockResolvedValue({
      defaultPath: "/bin/zsh",
    });
    vi.spyOn(configModule.configApi, "listFileOpeners").mockResolvedValue({
      apps: [],
    });

    vi.spyOn(configModule.configApi, "discoverAiModels").mockImplementation(
      mocks.discoverAiModels,
    );
    vi.spyOn(configModule.configApi, "validateAiApi").mockImplementation(
      mocks.validateAiApi,
    );

    const useConfigModule = await import("./useConfig.ts");
    vi.spyOn(useConfigModule, "useConfig").mockImplementation(() => ({
      globalConfig: mocks.state.globalConfig,
      projectConfig: null,
      effectiveConfig: null,
      providers: mocks.state.providers,
      llmProviders: mocks.state.providers,
      loading: mocks.state.loading,
      reload: mocks.reload,
      updateGlobalConfig: mocks.updateGlobalConfig,
      updateProjectConfig: vi.fn(),
      resetProjectConfig: vi.fn(),
    }));
  });

  it("does not expose ACP configuration in settings", async () => {
    await renderPage();
    expect(screen.queryByText("OpenCode ACP")).not.toBeInTheDocument();
    expect(screen.queryByText("Cursor ACP")).not.toBeInTheDocument();
    expect((await import("../../adapters/transport/config")).configApi).not.toHaveProperty("discoverAcp");
  });

  it("opens a blank custom-provider dialog directly without applying a preset", async () => {
    const user = userEvent.setup();
    await renderPage();
    await user.click(screen.getByRole("button", { name: /添加/ }));
    const dialog = within(screen.getByRole("dialog"));
    expect(dialog.getByRole("heading", { name: "连接供应商" })).toBeVisible();
    expect(dialog.getByRole("textbox", { name: "服务地址" })).toHaveValue("");
    expect(dialog.getByLabelText("API Key", { exact: true })).toHaveValue("");
    await user.click(dialog.getByRole("button", { name: "API 协议" }));
    for (const protocol of ["OpenAI Chat Completions", "OpenAI Responses", "Anthropic Messages"])
      expect(screen.getByRole("option", { name: protocol })).toBeVisible();
    await user.keyboard("{Escape}");
    expect(mocks.updateGlobalConfig).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "取消", exact: true }));
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(mocks.updateGlobalConfig).not.toHaveBeenCalled();
  });

  it("renders configured LLM provider cards with stored keys", async () => {
    mocks.state.globalConfig = createGlobalConfig({
      providerConnections: {
        openai: {
          providerId: "openai",
          baseUrl: "https://api.openai.com/v1",
          apiKeyMasked: "sk-o****1234",
          extra: { kind: "api", apiFormat: "openai", model: "gpt-4o-mini" },
        },
        anthropic: {
          providerId: "anthropic",
          baseUrl: "https://api.anthropic.com/v1",
          apiKeyMasked: "sk-a****9999",
          extra: {
            kind: "api",
            apiFormat: "anthropic",
            model: "claude-3-5-sonnet-latest",
          },
        },
      },
    });
    mocks.state.providers = mocks.state.globalConfig.providers;

    await renderPage();

    expect(screen.getByText("OpenAI")).toBeInTheDocument();
    expect(screen.getByText("Anthropic")).toBeInTheDocument();
    expect(screen.getByText("gpt-4o-mini")).toBeInTheDocument();
    expect(screen.getByText("claude-3-5-sonnet-latest")).toBeInTheDocument();
  });

  it("only persists a new provider after model selection and confirmation", async () => {
    const user = userEvent.setup();
    await renderPage();
    await openConnectedProvider(user);
    await user.type(screen.getByRole("textbox", { name: "模型 ID" }), "local-model{Enter}");
    expect(mocks.updateGlobalConfig).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "添加供应商", exact: true }));
    await waitFor(() => expect(mocks.updateGlobalConfig).toHaveBeenCalledOnce());
    const payload = mocks.updateGlobalConfig.mock.calls[0][0];
    const provider = payload.providers.find((item: ProviderDef) => item.id.startsWith("custom-api:"));
    expect(provider.models).toEqual([expect.objectContaining({ id: "local-model", isDefault: true })]);
    expect(payload.providerConnections[provider.id]).toMatchObject({ baseUrl: "https://llm.internal/v1", apiKey: "sk-local", extra: { model: "local-model" } });
    expect(payload.providers.some((item: ProviderDef) => item.kind === "acp")).toBe(false);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("hides limits and advanced settings, and lets users retry opening the config", async () => {
    const user = userEvent.setup();
    const { configApi } = await import("../../adapters/transport/config");
    const open = vi
      .spyOn(configApi, "openGlobalFile")
      .mockRejectedValueOnce(new Error("Editor could not start"))
      .mockResolvedValueOnce(undefined);
    await renderPage("general");
    expect(screen.queryByText("运行限制")).not.toBeInTheDocument();
    expect(screen.queryByText("高级")).not.toBeInTheDocument();
    const button = screen.getByRole("button", { name: "打开配置文件" });
    await user.click(button);
    expect(await screen.findByRole("alert")).toHaveTextContent(
      "Editor could not start",
    );
    await user.click(button);
    await waitFor(() =>
      expect(screen.queryByRole("alert")).not.toBeInTheDocument(),
    );
    expect(open).toHaveBeenCalledTimes(2);
  });

  it("discovers models as candidates and only configures the selected ones", async () => {
    const user = userEvent.setup();
    await renderPage();
    await openConnectedProvider(user);
    expect(screen.getByRole("checkbox", { name: "deepseek-chat", exact: true })).not.toBeChecked();
    expect(screen.getByRole("checkbox", { name: "deepseek-reasoner", exact: true })).not.toBeChecked();
    await user.click(screen.getByRole("checkbox", { name: "deepseek-chat", exact: true }));
    expect(mocks.updateGlobalConfig).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "添加供应商", exact: true }));
    await waitFor(() => expect(mocks.updateGlobalConfig).toHaveBeenCalledOnce());
    const provider = mocks.updateGlobalConfig.mock.calls[0][0].providers.find((item: ProviderDef) => item.id.startsWith("custom-api:"));
    expect(provider.models.map((model: { id: string }) => model.id)).toEqual(["deepseek-chat"]);
  });

  it("configures the input window only for the selected default model", async () => {
    const user = userEvent.setup();
    await renderPage();
    await openConnectedProvider(user);
    await user.click(screen.getByRole("checkbox", { name: "deepseek-chat", exact: true }));
    await user.click(screen.getByRole("checkbox", { name: "deepseek-reasoner", exact: true }));
    await user.click(screen.getByRole("checkbox", { name: "输入上下文窗口支持 1M", exact: true }));
    await user.click(screen.getByRole("button", { name: "添加供应商", exact: true }));
    await waitFor(() => expect(mocks.updateGlobalConfig).toHaveBeenCalledOnce());
    const provider = mocks.updateGlobalConfig.mock.calls[0][0].providers.find((item: ProviderDef) => item.id.startsWith("custom-api:"));
    expect(provider.models.find((model: { id: string }) => model.id === "deepseek-chat")).toMatchObject({ contextLimit: 1_000_000 });
    expect(provider.models.find((model: { id: string }) => model.id === "deepseek-reasoner").contextLimit).toBeUndefined();
  });

  it("preserves an incomplete draft during a visibility-triggered background reload", async () => {
    const user = userEvent.setup();
    const view = await renderPage();
    await user.click(screen.getByRole("button", { name: /添加/ }));
    await pasteValue(
      user,
      screen.getByRole("textbox", { name: "服务地址" }),
      "https://unfinished.example",
    );
    fireEvent(document, new Event("visibilitychange"));
    expect(mocks.reload).toHaveBeenCalled();

    const { default: Page } = await import("./GlobalSettingsPage");
    mocks.state.loading = true;
    view.rerender(
      <MemoryRouter initialEntries={["/settings?section=llmProviders"]}>
        <Page />
      </MemoryRouter>,
    );
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: "服务地址" })).toHaveValue(
      "https://unfinished.example",
    );
    mocks.state.loading = false;
    mocks.state.globalConfig = createGlobalConfig();
    view.rerender(
      <MemoryRouter initialEntries={["/settings?section=llmProviders"]}>
        <Page />
      </MemoryRouter>,
    );
    expect(screen.getByRole("textbox", { name: "服务地址" })).toHaveValue(
      "https://unfinished.example",
    );
    expect(mocks.updateGlobalConfig).not.toHaveBeenCalled();
  });

  it("commits the selected connection and model together on completion", async () => {
    const user = userEvent.setup();
    await renderPage();
    await openConnectedProvider(user);
    await user.click(screen.getByRole("checkbox", { name: "deepseek-chat", exact: true }));
    expect(mocks.updateGlobalConfig).not.toHaveBeenCalled();
    await user.click(screen.getByRole("button", { name: "添加供应商", exact: true }));
    await waitFor(() => expect(mocks.updateGlobalConfig).toHaveBeenCalledOnce());
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
    expect(mocks.reload).toHaveBeenCalled();
  });

  it("sets a selected model as default before saving", async () => {
    const user = userEvent.setup();
    await renderPage();
    await openConnectedProvider(user);
    for (const name of ["deepseek-chat", "deepseek-reasoner"]) await user.click(screen.getByRole("checkbox", { name, exact: true }));
    await user.click(screen.getByRole("button", { name: "deepseek-reasoner 设为默认" }));
    await user.click(screen.getByRole("button", { name: "添加供应商", exact: true }));
    await waitFor(() => expect(mocks.updateGlobalConfig).toHaveBeenCalledOnce());
    const payload = mocks.updateGlobalConfig.mock.calls[0][0];
    const provider = payload.providers.find((item: ProviderDef) => item.id.startsWith("custom-api:"));
    expect(payload.providerConnections[provider.id].extra.model).toBe("deepseek-reasoner");
  });

  it("preserves entered connection and selected models after a failed save", async () => {
    const user = userEvent.setup();
    await renderPage();
    await openConnectedProvider(user);
    await user.click(screen.getByRole("checkbox", { name: "deepseek-chat", exact: true }));
    mocks.updateGlobalConfig.mockRejectedValueOnce(new Error("写入失败"));
    await user.click(screen.getByRole("button", { name: "添加供应商", exact: true }));
    expect(await screen.findByRole("alert")).toHaveTextContent("写入失败");
    expect(screen.getByRole("checkbox", { name: "deepseek-chat", exact: true })).toBeChecked();
    await user.click(screen.getByRole("button", { name: "添加供应商", exact: true }));
    await waitFor(() => expect(mocks.updateGlobalConfig).toHaveBeenCalledTimes(2));
    expect(mocks.updateGlobalConfig.mock.calls[1][0]).toEqual(mocks.updateGlobalConfig.mock.calls[0][0]);
    await waitFor(() => expect(screen.queryByRole("dialog")).not.toBeInTheDocument());
  });

  it("removes a configured provider card", async () => {
    const user = userEvent.setup();
    const deepseekProvider: ProviderDef = {
      id: "custom-api:deepseek",
      label: "DeepSeek",
      description: "DeepSeek OpenAI-compatible API",
      status: "live",
      kind: "api",
      caps: { canFollowUp: true, canCancel: true },
      models: [
        { id: "deepseek-chat", label: "deepseek-chat", isDefault: true },
      ],
    };
    mocks.state.globalConfig = createGlobalConfig({
      providers: [...acpProviders, deepseekProvider],
      providerConnections: {
        "custom-api:deepseek": {
          providerId: "custom-api:deepseek",
          baseUrl: "https://api.deepseek.com",
          apiKeyMasked: "sk-d****5678",
          extra: { kind: "api", apiFormat: "openai", model: "deepseek-chat" },
        },
      },
    });
    mocks.state.providers = mocks.state.globalConfig.providers;
    await renderPage();

    expect(screen.getByText("DeepSeek")).toBeInTheDocument();
    fireEvent.click(screen.getByText("DeepSeek").closest("button")!);
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /删除/ })).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /删除/ }));
    expect(mocks.updateGlobalConfig).not.toHaveBeenCalled();
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "删除",
        exact: true,
      }),
    );

    expect(mocks.updateGlobalConfig).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: expect.not.arrayContaining([
          expect.objectContaining({ id: "custom-api:deepseek" }),
        ]),
      }),
    );
  });

  it("sets a configured provider as default", async () => {
    const user = userEvent.setup();
    const deepseekProvider: ProviderDef = {
      id: "custom-api:deepseek",
      label: "DeepSeek",
      description: "DeepSeek OpenAI-compatible API",
      status: "live",
      kind: "api",
      caps: { canFollowUp: true, canCancel: true },
      models: [
        { id: "deepseek-chat", label: "deepseek-chat", isDefault: true },
      ],
    };
    mocks.state.globalConfig = createGlobalConfig({
      providers: [...acpProviders, deepseekProvider],
      providerConnections: {
        "custom-api:deepseek": {
          providerId: "custom-api:deepseek",
          baseUrl: "https://api.deepseek.com",
          apiKeyMasked: "sk-d****5678",
          extra: { kind: "api", apiFormat: "openai", model: "deepseek-chat" },
        },
      },
    });
    mocks.state.providers = mocks.state.globalConfig.providers;
    await renderPage();

    fireEvent.click(screen.getByText("DeepSeek").closest("button")!);
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /设为默认/ }),
      ).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /设为默认/ }));

    expect(mocks.updateGlobalConfig).toHaveBeenCalledWith({
      defaultApiProviderId: "custom-api:deepseek",
    });
  });
});
